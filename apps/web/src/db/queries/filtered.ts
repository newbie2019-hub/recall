import { db } from '../client'
import * as repo from '../repo'
import {
  DEFAULT_FILTER,
  borrowStmt,
  borrowedForReplaySql,
  matchSql,
  parseFilterConfig,
  replayReviews,
  returnCardStmt,
  returnDeckStmt,
  returnStrandedStmt,
  type FilterConfig,
  type RatingValue,
  type Review,
  type Stmt,
} from '@recall/core'

/**
 * Filtered decks, against the collection. The SQL that decides *which* cards
 * move lives in `@recall/core/filtered` so React Native runs the same filter;
 * this module is the wiring, plus the two things that need FSRS and therefore
 * cannot be a statement: restoring a borrowed card's schedule, and answering
 * one.
 */

const id = () => crypto.randomUUID()

/**
 * A rebuilt card, written back the way `repo.recordReview` writes one. Copied
 * rather than imported because `repo.ts` keeps it private and is not mine to
 * change; if a third caller appears, export it there and delete this.
 */
const UPDATE_SCHEDULE = `UPDATE cards SET due=?, stability=?, difficulty=?, state=?,
  learning_steps=?, reps=?, lapses=?, last_review=? WHERE id=?`

export interface FilteredDeck {
  id: string
  name: string
  config: FilterConfig
  /** Cards currently borrowed. What "Empty" would send home. */
  cards: number
}

export async function getFilteredDeck(deckId: string): Promise<FilteredDeck | null> {
  const [row] = await db.select<{ id: string; name: string; filter_config: string | null; cards: number }>(
    `SELECT d.id, d.name, d.filter_config,
            (SELECT COUNT(*) FROM cards c WHERE c.deck_id = d.id) AS cards
       FROM decks d WHERE d.id = ? AND d.filtered = 1`,
    [deckId],
  )
  return row
    ? { id: row.id, name: row.name, config: parseFilterConfig(row.filter_config), cards: row.cards }
    : null
}

/**
 * How many cards this filter would take, right now.
 *
 * The same statement the build runs, wrapped in a COUNT — so the number on the
 * form and the number of cards in the deck are the same promise (README rule 4)
 * rather than two queries that drift.
 */
export async function matchCount(
  cfg: FilterConfig,
  ownDeckId?: string | null,
  now = Date.now(),
): Promise<number> {
  const m = matchSql(cfg, now, ownDeckId)
  const [r] = await db.select<{ n: number }>(`SELECT COUNT(*) AS n FROM (${m.sql})`, m.params)
  return r?.n ?? 0
}

/**
 * Create the deck and fill it, in that order — the deck row has to exist before
 * a card can point at it.
 *
 * `new_per_day` is deliberately wide open: the daily new limit belongs to the
 * deck a card lives in, and throttling a 100-card cram to 20 because the
 * filtered deck inherited the default would make the deck badge lie about what
 * it can hand over. The home deck's limit still governs once the cards return.
 */
export async function createFilteredDeck(name: string, cfg: FilterConfig): Promise<string> {
  const deckId = id()
  const clean = name.trim() || 'Custom study'
  try {
    await db.run(
      `INSERT INTO decks (id, parent_id, name, retention_target, new_per_day, updated_at,
                          filtered, filter_config)
       VALUES (?, NULL, ?, 0.9, 9999, ?, 1, ?)`,
      [deckId, clean, Date.now(), JSON.stringify(cfg)],
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw /UNIQUE|constraint/i.test(msg)
      ? new Error(`There is already a deck called “${clean}”`)
      : new Error(msg)
  }
  await rebuild(deckId, cfg)
  return deckId
}

/** Rename, re-save the search, and rebuild — the edit screen's one button. */
export async function saveFilteredDeck(deckId: string, name: string, cfg: FilterConfig) {
  await db.run('UPDATE decks SET name = ?, filter_config = ?, updated_at = ? WHERE id = ?', [
    name.trim() || 'Custom study',
    JSON.stringify(cfg),
    Date.now(),
    deckId,
  ])
  return rebuild(deckId, cfg)
}

/**
 * Empty, then build, in one transaction.
 *
 * Empty-first is what makes a rebuild idempotent instead of additive, and doing
 * it in one batch means a crash lands on one side or the other: cards at home,
 * or cards borrowed with a home recorded. There is no third state to recover.
 */
export async function rebuild(deckId: string, cfg?: FilterConfig, now = Date.now()): Promise<number> {
  const config = cfg ?? (await getFilteredDeck(deckId))?.config ?? DEFAULT_FILTER
  await db.batch([
    ...(await returnHome('deck', deckId, now)),
    // Cards a deleted filtered deck left flagged as borrowed would otherwise be
    // invisible to every future build. Cheap: the index is partial. Their due
    // stays pulled forward — they look due today, which is the honest reading
    // of a cram that was deleted rather than emptied.
    returnStrandedStmt(now),
    borrowStmt(deckId, config, now),
  ])
  const [r] = await db.select<{ n: number }>('SELECT COUNT(*) AS n FROM cards WHERE deck_id = ?', [deckId])
  return r?.n ?? 0
}

export async function emptyFilteredDeck(deckId: string, now = Date.now()): Promise<void> {
  await db.batch(await returnHome('deck', deckId, now))
}

/**
 * Delete: the cards go home **first**.
 *
 * `repo.deleteDeck` on its own does not lose them — their notes live in other
 * decks, so nothing cascades — but it releases `deck_id` to NULL, which throws
 * away a template override and leaves `original_deck_id` set forever.
 */
export async function deleteFilteredDeck(deckId: string): Promise<void> {
  await emptyFilteredDeck(deckId)
  await repo.deleteDeck(deckId)
}

/**
 * Answering a card while it is borrowed.
 *
 * **Reschedule off writes nothing to the review log.** The log has no column
 * saying "this was a cram answer", and `replayReviews()` re-applies every row
 * it finds — so a flagged row is not something that can exist honestly today,
 * and an unflagged one would quietly reschedule the card on the next cache
 * rebuild. Not writing is the only version of "reschedule off" that is still
 * true tomorrow. The cost is that a cram is invisible to the dashboard.
 *
 * ponytail: the flagged-row version needs one column —
 * `ALTER TABLE reviews ADD COLUMN cram INTEGER NOT NULL DEFAULT 0` — plus
 * `replayReviews()` skipping `cram = 1` and the stats queries filtering it out.
 * Add it the day someone wants cram answers in their history.
 *
 * The card leaves the deck on answer, because with its schedule untouched
 * `nextCard` would hand it straight back forever.
 */
export async function answerCard(
  sc: repo.StudyCard,
  rating: RatingValue,
  durationMs: number,
  now = Date.now(),
) {
  const [row] = await db.select<{ filtered: number; filter_config: string | null; home_retention: number | null }>(
    `SELECT d.filtered, d.filter_config,
            (SELECT retention_target FROM decks h WHERE h.id = c.original_deck_id) AS home_retention
       FROM cards c
       JOIN notes n ON n.id = c.note_id
       JOIN decks d ON d.id = COALESCE(c.deck_id, n.deck_id)
      WHERE c.id = ?`,
    [sc.card.id],
  )

  if (row?.filtered && !parseFilterConfig(row.filter_config).reschedule) {
    await db.batch([...(await returnHome('card', sc.card.id, now)), returnCardStmt(sc.card.id, now)])
    return sc.card
  }

  // A borrowed card is scheduled against the retention target of the deck it
  // came from, not the cram deck's: that target is the user's decision about
  // *those* cards, and replaying the log on the way out uses it too — so the
  // schedule a cram writes is the schedule a later rebuild reproduces.
  return repo.recordReview(
    { ...sc, retentionTarget: row?.home_retention ?? sc.retentionTarget },
    rating,
    durationMs,
    now,
  )
}

/**
 * Put borrowed cards back where they were — schedule first, then deck.
 *
 * There is no `original_due` column, and none is needed: `cards` is a derived
 * cache of the append-only log (README rule 1), so replaying the log restores
 * the real due date exactly, including for a card the build pulled forward and
 * for one that was answered during a rescheduling cram. A card with no log is
 * left alone — replaying nothing would return a *new* card and wipe an imported
 * schedule that predates this device.
 */
async function returnHome(
  scope: 'deck' | 'card',
  key: string,
  now: number,
): Promise<Stmt[]> {
  const borrowed = await db.select<{ id: string; note_id: string; ord: number; retention_target: number }>(
    borrowedForReplaySql(scope),
    [key],
  )
  const stmts: Stmt[] = []
  if (borrowed.length) {
    const holes = borrowed.map(() => '?').join(',')
    const log = await db.select<Review>(
      `SELECT * FROM reviews WHERE card_id IN (${holes}) ORDER BY ts`,
      borrowed.map((c) => c.id),
    )
    for (const c of borrowed) {
      const own = log.filter((r) => r.card_id === c.id)
      if (!own.length) continue
      const card = replayReviews(
        { id: c.id, note_id: c.note_id, ord: c.ord },
        own,
        c.retention_target,
        own[0]!.ts,
      )
      stmts.push({
        sql: UPDATE_SCHEDULE,
        params: [card.due, card.stability, card.difficulty, card.state,
                 card.learning_steps, card.reps, card.lapses, card.last_review, card.id],
      })
    }
  }
  if (scope === 'deck') stmts.push(returnDeckStmt(key, now))
  return stmts
}
