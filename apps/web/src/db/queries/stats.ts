/**
 * Everything the dashboard asks the collection.
 *
 * All of it is a query over the append-only `reviews` log, which is the only
 * reason these numbers can be honest: `cards` is a derived cache that an FSRS
 * parameter change, an undo or a `replayReviews()` rebuild can move, while the
 * log records what was actually shown and how it was actually answered. Two
 * things here read `cards` anyway and say why at the call site.
 *
 * Lives outside `repo.ts` on purpose — see the brief: five workstreams appending
 * to one 1,300-line module is a merge conflict with extra steps.
 */
import { db } from '../client.ts'
import {
  detectLeech, siblingsToBury, nextDayStart, stripHtml, LEECH_TAG,
  type LeechVerdict, type LeechOptions, type Review, type CardStateName,
} from '@recall/core'

const DAY = 86_400_000

/** Spelled the same way in every deck-scoped query in the app (repo.ts). */
const DECK_OF = 'COALESCE(c.deck_id, n.deck_id)'

/**
 * The reviews that were real recall tests, with the gap that preceded each.
 *
 * This is `recallTests()` from `@recall/core/leech` expressed in SQL: a review
 * counts only when the card's previous answer was at least a day earlier, so
 * the ten-minute relearning steps after a lapse are not counted as eight
 * separate memory tests. Change the rule in one place and the dashboard stops
 * agreeing with the leech list, so they carry each other's name.
 *
 * The window filter is applied *outside* this CTE: filtering inside it would
 * strip the predecessor of the window's first review and silently drop it.
 */
export const RECALL_TESTS = `
  SELECT r.card_id, r.ts, r.rating, r.duration_ms,
         r.ts - LAG(r.ts) OVER (PARTITION BY r.card_id ORDER BY r.ts) AS gap
    FROM reviews r`

const MATURE = 21 * DAY

const startOfToday = () => new Date(new Date().setHours(0, 0, 0, 0)).getTime()

// ── true retention vs. the target the user set ────────────────────────────

export interface RetentionRow {
  deck_id: string
  deck: string
  /** What the user asked FSRS for. */
  target: number
  tested: number
  passed: number
  mature_tested: number
  mature_passed: number
}

/**
 * The number that tells someone their settings are wrong.
 *
 * FSRS schedules for a requested retention; whether it lands is only knowable
 * from the log. A deck asking for 90% and delivering 74% is not a hard deck, it
 * is a deck whose intervals are too long — and nothing in Anki's stats puts
 * those two figures next to each other per deck.
 */
export function retention(sinceDays = 365): Promise<RetentionRow[]> {
  return db.select<RetentionRow>(
    `WITH tested AS (${RECALL_TESTS})
     SELECT d.id AS deck_id, d.name AS deck, d.retention_target AS target,
            COUNT(*) AS tested,
            SUM(CASE WHEN t.rating > 1 THEN 1 ELSE 0 END) AS passed,
            SUM(CASE WHEN t.gap >= ?2 THEN 1 ELSE 0 END) AS mature_tested,
            SUM(CASE WHEN t.gap >= ?2 AND t.rating > 1 THEN 1 ELSE 0 END) AS mature_passed
       FROM tested t
       JOIN cards c ON c.id = t.card_id
       JOIN notes n ON n.id = c.note_id
       JOIN decks d ON d.id = ${DECK_OF}
      WHERE t.gap >= ?3 AND t.ts >= ?1
      GROUP BY d.id
      HAVING tested > 0
      ORDER BY (CAST(passed AS REAL) / tested) - target`,
    [Date.now() - sinceDays * DAY, MATURE, DAY],
  )
}

// ── worst topics, rolled up the tag tree ──────────────────────────────────

export interface TopicRow {
  /** `anatomy::thorax`, or `anatomy` for the rolled-up parent. */
  tag: string
  depth: number
  tested: number
  failed: number
  cards: number
}

/**
 * Lapse rate per tag, with `anatomy::thorax` counted into `anatomy` as well.
 *
 * The rollup is done here rather than in SQL because the tag tree is a string
 * convention, not a table — expanding `a::b::c` into its three prefixes is one
 * line of JavaScript and a recursive CTE over a split-on-`::` would not be.
 * Each note contributes to a prefix once (the `Set`), so a note tagged both
 * `anatomy::thorax` and `anatomy::heart` is not counted twice under `anatomy`.
 */
export async function worstTopics(sinceDays = 365, minTested = 10): Promise<TopicRow[]> {
  const rows = await db.select<{ tags: string; card_id: string; tested: number; failed: number }>(
    `WITH tested AS (${RECALL_TESTS})
     SELECT n.tags AS tags, t.card_id AS card_id,
            COUNT(*) AS tested,
            SUM(CASE WHEN t.rating = 1 THEN 1 ELSE 0 END) AS failed
       FROM tested t
       JOIN cards c ON c.id = t.card_id
       JOIN notes n ON n.id = c.note_id
      WHERE t.gap >= ?2 AND t.ts >= ?1 AND n.tags != ''
      GROUP BY t.card_id`,
    [Date.now() - sinceDays * DAY, DAY],
  )

  const acc = new Map<string, TopicRow>()
  for (const r of rows) {
    const prefixes = new Set<string>()
    for (const tag of r.tags.split(' ')) {
      if (!tag) continue
      const parts = tag.split('::')
      for (let i = 1; i <= parts.length; i++) prefixes.add(parts.slice(0, i).join('::'))
    }
    for (const p of prefixes) {
      const cur = acc.get(p) ?? { tag: p, depth: p.split('::').length - 1, tested: 0, failed: 0, cards: 0 }
      cur.tested += r.tested
      cur.failed += r.failed
      cur.cards += 1
      acc.set(p, cur)
    }
  }

  // A 100% lapse rate over three reviews is noise, not a weakness.
  return [...acc.values()]
    .filter((t) => t.tested >= minTested && t.failed > 0)
    .sort((a, b) => b.failed / b.tested - a.failed / a.tested)
}

// ── forecast load ─────────────────────────────────────────────────────────

export interface ForecastDay {
  /** Days from today. 0 is today, and carries everything already overdue. */
  day: number
  due: number
}

/**
 * Due counts for the coming weeks, so a wall is visible before you hit it.
 *
 * The one query that *must* read the `cards` cache: a future due date is the
 * scheduler's prediction, and a prediction does not exist in a log of what
 * already happened. Rebuild the cache and this chart is rebuilt with it.
 */
export async function forecast(days = 28): Promise<ForecastDay[]> {
  const start = startOfToday()
  const rows = await db.select<{ day: number; due: number }>(
    `SELECT MAX(CAST((c.due - ?1) / ?2 AS INTEGER), 0) AS day, COUNT(*) AS due
       FROM cards c
       JOIN notes n ON n.id = c.note_id
      WHERE c.suspended = 0 AND c.state != 'new' AND c.due < ?3
      GROUP BY day
      ORDER BY day`,
    [start, DAY, start + days * DAY],
  )
  const byDay = new Map(rows.map((r) => [r.day, r.due]))
  return Array.from({ length: days }, (_, day) => ({ day, due: byDay.get(day) ?? 0 }))
}

// ── streak, heatmap, time of day ──────────────────────────────────────────

export interface DayCount {
  /** Local midnight, epoch ms. */
  date: number
  reviews: number
  passed: number
}

/**
 * Reviews per local day, newest last.
 *
 * ponytail: days are bucketed by integer division from today's local midnight,
 * which is one hour wrong for reviews answered between midnight and 01:00 on
 * the two DST changeover days a year. SQLite's `localtime` modifier reads the
 * *host* TZ, which in a wasm worker is not reliably the user's. If a user ever
 * notices, bucket in JS from the raw timestamps.
 */
export async function daily(days = 365): Promise<DayCount[]> {
  const start = startOfToday() - (days - 1) * DAY
  const rows = await db.select<{ day: number; reviews: number; passed: number }>(
    `SELECT CAST((r.ts - ?1) / ?2 AS INTEGER) AS day,
            COUNT(*) AS reviews,
            SUM(CASE WHEN r.rating > 1 THEN 1 ELSE 0 END) AS passed
       FROM reviews r
      WHERE r.ts >= ?1
      GROUP BY day`,
    [start, DAY],
  )
  const byDay = new Map(rows.map((r) => [r.day, r]))
  return Array.from({ length: days }, (_, i) => ({
    date: start + i * DAY,
    reviews: byDay.get(i)?.reviews ?? 0,
    passed: byDay.get(i)?.passed ?? 0,
  }))
}

/**
 * Consecutive days studied, counting back from today.
 *
 * Today not being studied *yet* does not break the streak — at 09:00 the number
 * a user wants is what they have, not zero.
 */
export function streak(days: DayCount[]): number {
  let n = 0
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i]!.reviews > 0) n++
    else if (i < days.length - 1) break
  }
  return n
}

export interface HourRow {
  hour: number
  reviews: number
  passed: number
}

/**
 * Accuracy by hour of day. The "stop studying at 1am" chart.
 *
 * ponytail: the current UTC offset is applied to every historical timestamp, so
 * reviews from the other side of a DST change land an hour off. Fine for a
 * 24-bucket chart; not fine if this ever drives scheduling.
 */
export async function byHour(sinceDays = 90): Promise<HourRow[]> {
  const tz = -new Date().getTimezoneOffset() * 60_000
  const rows = await db.select<HourRow>(
    `SELECT CAST(((r.ts + ?2) / 3600000) % 24 AS INTEGER) AS hour,
            COUNT(*) AS reviews,
            SUM(CASE WHEN r.rating > 1 THEN 1 ELSE 0 END) AS passed
       FROM reviews r
      WHERE r.ts >= ?1
      GROUP BY hour`,
    [Date.now() - sinceDays * DAY, tz],
  )
  const byHourMap = new Map(rows.map((r) => [r.hour, r]))
  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    reviews: byHourMap.get(hour)?.reviews ?? 0,
    passed: byHourMap.get(hour)?.passed ?? 0,
  }))
}

// ── leeches, each with the reason ─────────────────────────────────────────

export interface LeechRow {
  card_id: string
  note_id: string
  ord: number
  deck: string
  /** First field, tags stripped — enough to recognise the card. */
  preview: string
  suspended: boolean
  flag: number
  verdict: LeechVerdict
}

interface CandidateRow {
  id: string
  note_id: string
  ord: number
  lapses: number
  suspended: number
  flag: number
  deck: string
  fields: string
  nt_fields: string
  sort_field: number
}

/**
 * Leeches, ranked, each carrying *why* — the part Anki does not do.
 *
 * `cards.lapses` is used to shortlist and nothing else: it is a cached counter
 * and it is indexed-cheap, but the verdict and the lapse count shown to the
 * user are recounted from the log by `detectLeech`. The note's other cards come
 * along in the same history fetch, because "confused with its own reverse" is
 * the most useful reason on the list and needs them.
 */
export async function leeches(
  options: Partial<LeechOptions> = {},
  limit = 50,
): Promise<LeechRow[]> {
  const threshold = options.threshold ?? 8
  const candidates = await db.select<CandidateRow>(
    `SELECT c.id, c.note_id, c.ord, c.lapses, c.suspended, c.flag,
            d.name AS deck, n.fields, nt.fields AS nt_fields, nt.sort_field
       FROM cards c
       JOIN notes n ON n.id = c.note_id
       JOIN decks d ON d.id = ${DECK_OF}
       JOIN note_types nt ON nt.id = n.note_type
      WHERE c.lapses >= ?1
      ORDER BY c.lapses DESC
      LIMIT ?2`,
    [Math.max(1, threshold - 2), limit],
  )
  if (!candidates.length) return []

  const noteIds = [...new Set(candidates.map((c) => c.note_id))]
  const history = await db.select<Review & { note_id: string; ord: number }>(
    `SELECT r.id, r.card_id, r.ts, r.rating, r.duration_ms, c.note_id, c.ord
       FROM reviews r JOIN cards c ON c.id = r.card_id
      WHERE c.note_id IN (${noteIds.map(() => '?').join(',')})
      ORDER BY r.ts`,
    noteIds,
  )

  const byCard = new Map<string, Review[]>()
  const byNote = new Map<string, { id: string; ord: number }[]>()
  for (const r of history) {
    if (!byCard.has(r.card_id)) {
      byCard.set(r.card_id, [])
      byNote.set(r.note_id, [...(byNote.get(r.note_id) ?? []), { id: r.card_id, ord: r.ord }])
    }
    byCard.get(r.card_id)!.push(r)
  }

  return candidates
    .map((c) => {
      const siblings = (byNote.get(c.note_id) ?? [])
        .filter((s) => s.id !== c.id)
        .map((s) => ({ ...s, history: byCard.get(s.id) ?? [] }))
      return {
        card_id: c.id,
        note_id: c.note_id,
        ord: c.ord,
        deck: c.deck,
        preview: preview(c),
        suspended: !!c.suspended,
        flag: c.flag,
        verdict: detectLeech({ id: c.id, ord: c.ord }, byCard.get(c.id) ?? [], siblings, options),
      }
    })
    .filter((r) => r.verdict.leech)
    .sort((a, b) => b.verdict.lapses - a.verdict.lapses)
}

function preview(c: CandidateRow): string {
  const fields = JSON.parse(c.fields) as Record<string, string>
  const names = JSON.parse(c.nt_fields) as string[]
  const raw = fields[names[c.sort_field] ?? names[0] ?? ''] ?? Object.values(fields)[0] ?? ''
  return stripHtml(raw).trim().slice(0, 120)
}

/**
 * The scheduler side: check one card the moment it is failed.
 *
 * `recordReview` calls this after an Again (see the report's repo.ts edit
 * list). It writes only when the verdict *fires* — at the threshold, then every
 * half threshold — so unsuspending a leech does not re-suspend it on its very
 * next failure, which is the nag that makes people turn the feature off.
 *
 * ponytail: `options` defaults to Anki's 8/suspend because migration 7 added no
 * per-deck leech columns (reported). When they land, read them off the card's
 * deck here — nothing else has to change, the verdict is already a pure
 * function of card + history + options.
 */
export async function checkLeech(
  cardId: string,
  noteId: string,
  options: Partial<LeechOptions> = {},
  now = Date.now(),
): Promise<LeechVerdict | null> {
  const history = await db.select<Review & { card_id: string; ord: number }>(
    `SELECT r.id, r.card_id, r.ts, r.rating, r.duration_ms, c.ord
       FROM reviews r JOIN cards c ON c.id = r.card_id
      WHERE c.note_id = ?
      ORDER BY r.ts`,
    [noteId],
  )
  const mine = history.filter((r) => r.card_id === cardId)
  const siblings = [...new Map(history.filter((r) => r.card_id !== cardId).map((r) => [r.card_id, r])).values()]
    .map((r) => ({
      id: r.card_id,
      ord: r.ord,
      history: history.filter((h) => h.card_id === r.card_id),
    }))

  const ord = mine[0]?.ord ?? 0
  const verdict = detectLeech({ id: cardId, ord }, mine, siblings, options)
  if (verdict.fires) await writeVerdict(cardId, noteId, verdict, now)
  return verdict.leech ? verdict : null
}

/**
 * Write a leech verdict: the reserved tag, plus suspend or flag per the option.
 *
 * The tag goes on the *note* because that is where Anki puts it and where the
 * tag sidebar reads it; the suspension goes on the card, because the reverse of
 * a leech is often fine. `state_updated_at` is bumped for the same reason
 * migration 7 added it — suspended/flag are a decision the user syncs, not
 * derived state.
 */
export const applyLeech = (row: LeechRow, now = Date.now()): Promise<void> =>
  row.verdict.leech ? writeVerdict(row.card_id, row.note_id, row.verdict, now) : Promise.resolve()

async function writeVerdict(
  cardId: string,
  noteId: string,
  verdict: LeechVerdict,
  now: number,
): Promise<void> {
  const writes: { sql: string; params?: unknown[] }[] = [
    {
      // The NOT LIKE makes it idempotent: a second firing must not leave the
      // note tagged `leech leech`.
      sql: `UPDATE notes
               SET tags = TRIM(tags || ' ' || ?), updated_at = ?
             WHERE id = ? AND (' ' || tags || ' ') NOT LIKE ?`,
      params: [LEECH_TAG, now, noteId, `% ${LEECH_TAG} %`],
    },
  ]
  if (verdict.suspend)
    writes.push({
      sql: 'UPDATE cards SET suspended = 1, state_updated_at = ? WHERE id = ?',
      params: [now, cardId],
    })
  else if (verdict.flag !== null)
    writes.push({
      sql: 'UPDATE cards SET flag = ?, state_updated_at = ? WHERE id = ?',
      params: [verdict.flag, now, cardId],
    })
  await db.batch(writes)
}

// ── sibling burying ───────────────────────────────────────────────────────

/**
 * Hide the answered card's siblings until tomorrow.
 *
 * Called from `recordReview` (see the report's repo.ts edit list). It is safe
 * to run after the review has landed rather than inside its batch: the decision
 * is idempotent, and nothing reads the counts between the two statements.
 *
 * Rule 4 holds for free here and it is worth being explicit about *why*:
 * `nextCard`, `deckTree` and therefore `counts` already carry the identical
 * `(buried_until IS NULL OR buried_until <= now)` filter, so the row this
 * writes removes the card from the badge, the session counter and the study
 * loop in the same instant. If burying is ever moved somewhere that skips one
 * of those three, the deck says "3 due" and hands over two cards.
 */
export async function burySiblings(
  cardId: string,
  noteId: string,
  now = Date.now(),
): Promise<string[]> {
  const cards = await db.select<{
    id: string; state: CardStateName; suspended: number; buried_until: number | null
  }>('SELECT id, state, suspended, buried_until FROM cards WHERE note_id = ?', [noteId])
  if (cards.length < 2) return []

  const until = nextDayStart(now)
  const ids = siblingsToBury(
    cardId,
    cards.map((c) => ({ ...c, suspended: !!c.suspended })),
    until,
  )
  if (!ids.length) return []

  await db.run(
    `UPDATE cards SET buried_until = ?, state_updated_at = ?
      WHERE id IN (${ids.map(() => '?').join(',')})`,
    [until, now, ...ids],
  )
  return ids
}
