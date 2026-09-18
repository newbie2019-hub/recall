/**
 * Filtered decks (custom study) — the statements, without a database.
 *
 * A filtered deck **is a deck row** with a search attached (migration 7), so
 * `deckTree`, the badges, `nextCard` and the recursive CTE all work on it
 * unchanged. Nothing here is a parallel "session" concept.
 *
 * Cards are *borrowed*: `deck_id` points at the filtered deck and
 * `original_deck_id` remembers where the card goes home to. Both move in the
 * same UPDATE, which is the whole of the crash story — a card is either home or
 * borrowed-with-a-home-recorded, never in between, whatever gets interrupted.
 *
 * Pure so React Native reuses it: SQL strings and bound parameters, no db
 * handle, no DOM.
 */
import { parseSearch, searchSql } from './search.ts'

export type FilterOrder = 'due' | 'random' | 'lapses'

export interface FilterConfig {
  /** A `search.ts` string — `tag:exam is:due`. Empty means the whole collection. */
  search: string
  limit: number
  order: FilterOrder
  /** False = cram: answers must not touch the card's schedule at all. */
  reschedule: boolean
}

export interface Stmt {
  sql: string
  params: unknown[]
}

export const DEFAULT_FILTER: FilterConfig = {
  search: '',
  limit: 100,
  order: 'due',
  reschedule: true,
}

const clampLimit = (n: unknown): number => {
  const v = Math.round(Number(n))
  return Number.isFinite(v) ? Math.min(9999, Math.max(1, v)) : DEFAULT_FILTER.limit
}

const ORDER_SQL: Record<FilterOrder, string> = {
  due: 'c.due ASC',
  random: 'RANDOM()',
  lapses: 'c.lapses DESC, c.due ASC',
}

export const FILTER_ORDERS = Object.keys(ORDER_SQL) as FilterOrder[]

/** Tolerant on the way in: `filter_config` is JSON a future version may extend. */
export function parseFilterConfig(raw: string | null | undefined): FilterConfig {
  let parsed: Partial<FilterConfig> = {}
  try {
    if (raw) parsed = JSON.parse(raw) as Partial<FilterConfig>
  } catch {
    parsed = {}
  }
  return {
    search: typeof parsed.search === 'string' ? parsed.search : DEFAULT_FILTER.search,
    // Clamped rather than rejected: the limit exists to keep a cram finishable,
    // and an absurd one is a slip, not a request for 2 million cards.
    limit: clampLimit(parsed.limit),
    order: parsed.order && parsed.order in ORDER_SQL ? parsed.order : DEFAULT_FILTER.order,
    reschedule: parsed.reschedule !== false,
  }
}

/**
 * Which cards this filter would take, in the order it would take them.
 *
 * The **one** set of filters (README rule 4): the build UPDATE wraps this, and
 * so does the "342 cards match" line in the build form. A form that promises
 * 342 and a deck that holds 300 is the deck badge lying by another route.
 *
 * `original_deck_id IS NULL` is the whole of the "a card is in at most one
 * filtered deck" rule: a borrowed card carries a non-NULL home, so no second
 * filtered deck can select it, and no index or extra bookkeeping is needed.
 * Suspended and buried cards are excluded because `nextCard` would refuse to
 * hand them over.
 *
 * `ownDeckId` is for counting a **rebuild** of a deck that is currently built:
 * a rebuild empties first, so its own cards are back in the pool by the time
 * the build runs. Only the count passes it — `borrowStmt` runs after the empty,
 * where the two are the same query.
 */
export function matchSql(cfg: FilterConfig, now: number, ownDeckId?: string | null): Stmt {
  // Parsed here rather than by the caller: three callers (build, count, and the
  // phone) have to agree on what the string means, and one of them parsing it
  // slightly differently is the deck badge lying again.
  const search = searchSql(parseSearch(cfg.search), now)
  return {
    sql: `SELECT c.id FROM cards c JOIN notes n ON n.id = c.note_id
           WHERE ${ownDeckId ? '(c.original_deck_id IS NULL OR c.deck_id IS ?)' : 'c.original_deck_id IS NULL'}
             AND c.suspended = 0
             AND (c.buried_until IS NULL OR c.buried_until <= ?)
             AND (${search.sql})
           ORDER BY ${ORDER_SQL[cfg.order]}
           LIMIT ?`,
    params: [...(ownDeckId ? [ownDeckId] : []), now, ...search.params, cfg.limit],
  }
}

/** The whole build, as one statement — see the file header on interruption. */
export function borrowStmt(deckId: string, cfg: FilterConfig, now: number): Stmt {
  const match = matchSql(cfg, now)
  return {
    sql: `UPDATE cards
             SET original_deck_id = COALESCE(deck_id, (SELECT deck_id FROM notes WHERE notes.id = cards.note_id)),
                 deck_id = ?,
                 due = CASE WHEN state != 'new' AND due > ? THEN ? ELSE due END,
                 state_updated_at = ?
           WHERE id IN (${match.sql})`,
    // COALESCE first: notes.deck_id is NOT NULL, so a borrowed card always has
    // a home recorded. A card that cannot find its way back is the one failure
    // this feature is not allowed to have.
    params: [deckId, now, now, now, ...match.params],
  }
}

/**
 * Pulling a card forward means moving its `due` to now — there is no
 * `original_due` column in migration 7, and there does not need to be: `due` is
 * derived state (README rule 1), so `replayReviews()` over the untouched log
 * rebuilds the real one on the way out. Cards that were already due keep their
 * overdue-ness so the deck still studies oldest-first.
 */
const RETURN_SET = `
  SET deck_id = CASE
        WHEN original_deck_id = (SELECT deck_id FROM notes WHERE notes.id = cards.note_id)
        THEN NULL ELSE original_deck_id END,
      original_deck_id = NULL,
      state_updated_at = ?`

// NULL rather than the home id when the card's home *is* its note's deck:
// `deck_id` is a template override (migration 3), and leaving a value there
// would silently freeze a card in a deck its note later moves out of.

/** Empty: every borrowed card in this deck goes home. Total, by construction. */
export const returnDeckStmt = (deckId: string, now: number): Stmt => ({
  sql: `UPDATE cards ${RETURN_SET} WHERE original_deck_id IS NOT NULL AND deck_id IS ?`,
  params: [now, deckId],
})

/** One card home mid-session — what a no-reschedule answer does. */
export const returnCardStmt = (cardId: string, now: number): Stmt => ({
  sql: `UPDATE cards ${RETURN_SET} WHERE original_deck_id IS NOT NULL AND id = ?`,
  params: [now, cardId],
})

/**
 * Cards left borrowed by a filtered deck that no longer exists.
 *
 * `repo.deleteDeck` releases `deck_id` to NULL and drops the deck row, which
 * does *not* delete the user's cards (their notes live elsewhere, so nothing
 * cascades) but does leave them flagged as borrowed forever — unable to join
 * another filtered deck, and with any template override lost. Running this
 * before a build repairs that; `deleteFilteredDeck` avoids it in the first
 * place.
 */
export const returnStrandedStmt = (now: number): Stmt => ({
  sql: `UPDATE cards ${RETURN_SET}
         WHERE original_deck_id IS NOT NULL
           AND (deck_id IS NULL OR deck_id NOT IN (SELECT id FROM decks WHERE filtered = 1))`,
  params: [now],
})

/**
 * The borrowed cards whose schedule has to be rebuilt from the log on the way
 * out, with the retention target of the deck they are going home to — not the
 * filtered deck's, which is a cram setting nobody chose for these cards.
 */
export const borrowedForReplaySql = (scope: 'deck' | 'card' | 'all') =>
  `SELECT c.id, c.note_id, c.ord, d.retention_target
     FROM cards c
     JOIN decks d ON d.id = c.original_deck_id
    WHERE c.original_deck_id IS NOT NULL
      AND c.state != 'new'
      ${scope === 'deck' ? 'AND c.deck_id IS ?' : scope === 'card' ? 'AND c.id = ?' : ''}`
