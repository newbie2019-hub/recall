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
  const boundaries = dayBoundaries(days)
  const rows = await db.select<{ ts: number; rating: number }>(
    'SELECT ts, rating FROM reviews WHERE ts >= ?',
    [boundaries[0]!],
  )
  return bucketByDay(rows, boundaries)
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
  const rows = await db.select<{ ts: number; rating: number }>(
    'SELECT ts, rating FROM reviews WHERE ts >= ?',
    [Date.now() - sinceDays * DAY],
  )
  return bucketByHour(rows)
}

/**
 * Both of these used to bucket in SQL, and both were an hour wrong across a
 * daylight-saving boundary.
 *
 * `daily()` divided by 86,400,000 from local midnight, which assumes every day
 * is exactly twenty-four hours — two days a year are not, so every bucket after
 * a change was shifted by an hour and reviews near midnight fell into the wrong
 * day. `byHour()` was worse: it applied *today's* UTC offset to every historical
 * timestamp, so a year of reviews was relabelled twice a year.
 *
 * SQLite's own `localtime` is not the answer either. In a wasm worker it reads
 * the host's timezone database, which is not reliably the user's.
 *
 * So the bucketing happens in JS, where `Date` knows the real offset for each
 * *individual* timestamp. The comments used to say "fine unless it drives
 * scheduling" — and 10d's briefing now reads both.
 */

/** Local midnights, newest last. Computed per day, so a 23- or 25-hour day is one day. */
export function dayBoundaries(days: number, now = Date.now()): number[] {
  const out: number[] = []
  const cursor = new Date(now)
  cursor.setHours(0, 0, 0, 0)

  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(cursor)
    // Date arithmetic, not millisecond arithmetic: `setDate` walks the calendar
    // and lands on the right midnight whatever the offset did in between.
    day.setDate(day.getDate() - i)
    day.setHours(0, 0, 0, 0)
    out.push(day.getTime())
  }

  return out
}

/** @param rows raw review timestamps, unbucketed */
export function bucketByDay(rows: { ts: number; rating: number }[], boundaries: number[]): DayCount[] {
  const counts = boundaries.map((date) => ({ date, reviews: 0, passed: 0 }))

  for (const row of rows) {
    // The last boundary at or before this review. A binary search would be
    // faster and this is 365 entries against a year of reviews read once.
    let i = counts.length - 1
    while (i > 0 && row.ts < counts[i]!.date) i--
    if (row.ts < counts[0]!.date) continue

    counts[i]!.reviews++
    if (row.rating > 1) counts[i]!.passed++
  }

  return counts
}

/** @param rows raw review timestamps, unbucketed */
export function bucketByHour(rows: { ts: number; rating: number }[]): HourRow[] {
  const counts = Array.from({ length: 24 }, (_, hour) => ({ hour, reviews: 0, passed: 0 }))

  for (const row of rows) {
    // `getHours()` uses the offset in force *at that instant*, which is the
    // whole point: an 08:00 review in January and an 08:00 review in July are
    // both hour 8, however the clocks moved in between.
    const hour = new Date(row.ts).getHours()
    counts[hour]!.reviews++
    if (row.rating > 1) counts[hour]!.passed++
  }

  return counts
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
  retention_target: number
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
  // Two lapses, not eight: the statistical test can call a card hopeless after
  // two failures it was expected to pass, so a shortlist gated on the old
  // threshold would hide exactly the cards the new test exists to catch. The
  // floor is only here to keep the history fetch from loading the collection.
  const candidates = await db.select<CandidateRow>(
    `SELECT c.id, c.note_id, c.ord, c.lapses, c.suspended, c.flag,
            d.name AS deck, d.retention_target, n.fields,
            nt.fields AS nt_fields, nt.sort_field
       FROM cards c
       JOIN notes n ON n.id = c.note_id
       JOIN decks d ON d.id = ${DECK_OF}
       JOIN note_types nt ON nt.id = n.note_type
      WHERE c.lapses >= 2
      ORDER BY c.lapses DESC
      LIMIT ?1`,
    [limit],
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
        verdict: detectLeech({ id: c.id, ord: c.ord }, byCard.get(c.id) ?? [], siblings, {
          ...options,
          retentionTarget: options.retentionTarget ?? c.retention_target,
        }),
      }
    })
    .filter((r) => r.verdict.leech)
    // Worst first means *most improbable* first, not most-failed: a card with
    // four lapses it should have passed is a bigger problem than one with nine
    // at intervals it was always going to miss.
    .sort((a, b) => (a.verdict.surprise ?? 1) - (b.verdict.surprise ?? 1) || b.verdict.lapses - a.verdict.lapses)
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
 * The deck's retention target is read here and passed through, which is what
 * switches `detectLeech` from counting lapses to asking whether these failures
 * were improbable. Without it, a card failing at intervals it was never going
 * to survive counts the same as one failing what it should have known.
 *
 * ponytail: the action and threshold still default to Anki's 8/suspend because
 * migration 7 added no per-deck leech columns. When they land, read them off
 * the same row — nothing else has to change.
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
  // The deck's target, so the answer path and the dashboard reach the same
  // verdict. Without it `detectLeech` silently falls back to counting lapses.
  const [deck] = await db.select<{ retention_target: number; created: number }>(
    `SELECT d.retention_target, COALESCE(MIN(r.ts), ?) AS created
       FROM cards c
       JOIN notes n ON n.id = c.note_id
       JOIN decks d ON d.id = COALESCE(c.deck_id, n.deck_id)
       LEFT JOIN reviews r ON r.card_id = c.id
      WHERE c.id = ?`,
    [now, cardId],
  )

  const mine = history.filter((r) => r.card_id === cardId)
  const siblings = [...new Map(history.filter((r) => r.card_id !== cardId).map((r) => [r.card_id, r])).values()]
    .map((r) => ({
      id: r.card_id,
      ord: r.ord,
      history: history.filter((h) => h.card_id === r.card_id),
    }))

  const ord = mine[0]?.ord ?? 0
  const verdict = detectLeech({ id: cardId, ord }, mine, siblings, {
    retentionTarget: deck?.retention_target,
    createdAt: deck?.created,
    ...options,
  })
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
  // The deck's own switches ride along with the cards. `siblingsToBury` has
  // taken them since it was written, and reading them here is what stops the
  // two columns on `decks` from being a setting that silently does nothing —
  // every card of one note shares a deck unless a template override moves it,
  // and the answered card's deck is the one whose rule applies.
  const cards = await db.select<{
    id: string; state: CardStateName; suspended: number; buried_until: number | null
    bury_new: number; bury_reviews: number
  }>(
    `SELECT c.id, c.state, c.suspended, c.buried_until, d.bury_new, d.bury_reviews
       FROM cards c
       JOIN notes n ON n.id = c.note_id
       LEFT JOIN decks d ON d.id = ${DECK_OF}
      WHERE c.note_id = ?`,
    [noteId],
  )
  if (cards.length < 2) return []

  const answered = cards.find((c) => c.id === cardId)
  const until = nextDayStart(now)
  const ids = siblingsToBury(
    cardId,
    cards.map((c) => ({ ...c, suspended: !!c.suspended })),
    until,
    // A missing row means a card whose deck has gone; the defaults are Anki's
    // and are what every deck gets until somebody turns one off.
    {
      newCards: (answered?.bury_new ?? 1) !== 0,
      reviews: (answered?.bury_reviews ?? 1) !== 0,
    },
  )
  if (!ids.length) return []

  await db.run(
    `UPDATE cards SET buried_until = ?, state_updated_at = ?
      WHERE id IN (${ids.map(() => '?').join(',')})`,
    [until, now, ...ids],
  )
  return ids
}

// ── time and composition (PLAN §7) ─────────────────────────────────────────

/**
 * Everything below is about *cost* rather than outcome, and the distinction is
 * why they are grouped apart.
 *
 * Time is a context variable here and never a headline. It is a weak and
 * unstable predictor of learning, it is trivially gamed by leaving the app
 * open, and for a fluent learner it runs the wrong way — knowing a card better
 * means answering it faster. What it is good for is honesty about what the
 * collection costs, which is a question no accuracy figure answers.
 *
 * All of it leans on `reviews.duration_ms` being trustworthy, which it only
 * became once the review clock started stopping for hidden tabs and idle time
 * and `recordReview` started capping each answer (`lib/stopwatch.ts`).
 */

export interface DayTime {
  date: number
  ms: number
  reviews: number
}

/** Minutes studied per day, for the heatmap and the "this week" tiles. */
export async function timeByDay(days = 365): Promise<DayTime[]> {
  const since = startOfDay(Date.now()) - (days - 1) * DAY
  const rows = await db.select<{ day: number; ms: number; n: number }>(
    `SELECT CAST((r.ts - ?) / ${DAY} AS INTEGER) AS day,
            SUM(r.duration_ms) AS ms, COUNT(*) AS n
       FROM reviews r
      WHERE r.ts >= ?
      GROUP BY day`,
    [since, since],
  )

  const byDay = new Map(rows.map((r) => [r.day, r]))
  return Array.from({ length: days }, (_, i) => ({
    date: since + i * DAY,
    ms: byDay.get(i)?.ms ?? 0,
    reviews: byDay.get(i)?.n ?? 0,
  }))
}

export interface DeckTime {
  deck: string
  ms: number
  reviews: number
}

/**
 * Where the time went, by deck.
 *
 * Attributed to the deck the card is in *now*, not the deck it was in when the
 * review happened — the log does not record the second, and a card that moved
 * last week did not retroactively spend its time somewhere else.
 */
export async function timeByDeck(days = 30, limit = 8): Promise<DeckTime[]> {
  const rows = await db.select<{ deck: string; ms: number; n: number }>(
    `SELECT d.name AS deck, SUM(r.duration_ms) AS ms, COUNT(*) AS n
       FROM reviews r
       JOIN cards c ON c.id = r.card_id
       JOIN notes n ON n.id = c.note_id
       JOIN decks d ON d.id = ${DECK_OF}
      WHERE r.ts >= ?
      GROUP BY d.id
      ORDER BY ms DESC`,
    [Date.now() - days * DAY],
  )

  // Everything past the top few becomes one row rather than a long tail nobody
  // reads: "which deck is eating my week" has at most a handful of answers.
  const head = rows.slice(0, limit).map((r) => ({ deck: r.deck, ms: r.ms, reviews: r.n }))
  const tail = rows.slice(limit)
  if (tail.length) {
    head.push({
      deck: `${tail.length} other decks`,
      ms: tail.reduce((s, r) => s + r.ms, 0),
      reviews: tail.reduce((s, r) => s + r.n, 0),
    })
  }
  return head
}

/**
 * How long a card takes, as a distribution plus the three numbers worth saying
 * out loud.
 *
 * A histogram, not a box plot: box plots are misread by students and experts
 * alike — whiskers taken for the range, the box taken for frequency — and this
 * screen is read by people who came here to study medicine, not statistics. The
 * percentiles carry what a box would have claimed to show, in words.
 *
 * The last bucket is an explicit overflow. Answer times are heavily
 * right-skewed and a linear axis out to the cap would be one tall bar and a lot
 * of white space.
 */
export interface AnswerTimes {
  buckets: { upTo: number; n: number }[]
  median: number
  p90: number
  total: number
}

const TIME_BUCKETS = [2, 4, 6, 8, 10, 15, 20, 30, 45, 60]

export async function answerTimes(days = 30): Promise<AnswerTimes> {
  const rows = await db.select<{ ms: number }>(
    `SELECT duration_ms AS ms FROM reviews WHERE ts >= ? AND duration_ms > 0 ORDER BY duration_ms`,
    [Date.now() - days * DAY],
  )

  const buckets = TIME_BUCKETS.map((upTo) => ({ upTo, n: 0 }))
  for (const { ms } of rows) {
    const s = ms / 1000
    const i = TIME_BUCKETS.findIndex((upTo) => s <= upTo)
    buckets[i === -1 ? buckets.length - 1 : i]!.n++
  }

  const at = (q: number) => (rows.length ? rows[Math.min(rows.length - 1, Math.floor(rows.length * q))]!.ms : 0)
  return { buckets, median: at(0.5), p90: at(0.9), total: rows.length }
}

/**
 * Which buttons get pressed.
 *
 * Restricted to real recall tests for the same reason the retention figure is:
 * counting the ten-minute relearning steps after a lapse would report mostly
 * how many learning steps are configured.
 */
export interface ButtonCounts {
  again: number
  hard: number
  good: number
  easy: number
}

export async function answerButtons(days = 30): Promise<ButtonCounts> {
  const [row] = await db.select<ButtonCounts>(
    `WITH tests AS (${RECALL_TESTS})
     SELECT SUM(rating = 1) AS again, SUM(rating = 2) AS hard,
            SUM(rating = 3) AS good, SUM(rating = 4) AS easy
       FROM tests WHERE gap >= ${DAY} AND ts >= ?`,
    [Date.now() - days * DAY],
  )
  return {
    again: row?.again ?? 0, hard: row?.hard ?? 0,
    good: row?.good ?? 0, easy: row?.easy ?? 0,
  }
}

/**
 * What the collection is made of.
 *
 * Anki's maturity boundary — an interval of 21 days or more is "mature" — so
 * the number means the same thing to anyone arriving from there. Suspended
 * cards are counted apart rather than dropped: a collection that is a third
 * suspended is a fact about it, and hiding that makes the other numbers look
 * better than they are.
 */
export interface CardCounts {
  new: number
  learning: number
  young: number
  mature: number
  suspended: number
}

export async function cardCounts(): Promise<CardCounts> {
  const [row] = await db.select<CardCounts>(
    `SELECT
       SUM(suspended = 0 AND state = 'new') AS "new",
       SUM(suspended = 0 AND state IN ('learning','relearning')) AS learning,
       SUM(suspended = 0 AND state = 'review' AND stability < 21) AS young,
       SUM(suspended = 0 AND state = 'review' AND stability >= 21) AS mature,
       SUM(suspended = 1) AS suspended
     FROM cards`,
  )
  return {
    new: row?.new ?? 0, learning: row?.learning ?? 0, young: row?.young ?? 0,
    mature: row?.mature ?? 0, suspended: row?.suspended ?? 0,
  }
}

/**
 * What you owe the scheduler, and what it will cost you every day from here.
 *
 * **Burden** is SuperMemo's oldest good idea and nothing in Anki shows it:
 * summing `1/interval` across the collection gives the reviews per day the
 * collection has committed you to at a steady state. A card on a hundred-day
 * interval contributes 0.01 of a review a day, forever. Multiplied by how long
 * an answer actually takes, it is the honest answer to "what does adding two
 * hundred cards cost me" — a question no accuracy figure touches.
 */
export interface Workload {
  /** Cards past due right now. */
  overdue: number
  /** Median days late among them — one very old card should not set the tone. */
  medianDaysLate: number
  /** Reviews per day at a steady state. */
  burden: number
  /** Burden × the median answer time, in milliseconds. */
  dailyMs: number
}

export async function workload(now = Date.now()): Promise<Workload> {
  const [row] = await db.select<{ overdue: number; burden: number }>(
    `SELECT
       SUM(due <= ? AND state != 'new') AS overdue,
       -- Stability is the interval in days; a card with none is not scheduled
       -- and costs nothing yet.
       SUM(CASE WHEN state = 'review' AND stability >= 1 THEN 1.0 / stability ELSE 0 END) AS burden
     FROM cards WHERE suspended = 0`,
    [now],
  )

  const late = await db.select<{ days: number }>(
    `SELECT (? - due) / ${DAY} AS days FROM cards
      WHERE suspended = 0 AND state != 'new' AND due <= ?
      ORDER BY days`,
    [now, now],
  )

  const [time] = await db.select<{ ms: number }>(
    `SELECT AVG(duration_ms) AS ms FROM reviews WHERE ts >= ? AND duration_ms > 0`,
    [now - 30 * DAY],
  )

  const burden = row?.burden ?? 0
  return {
    overdue: row?.overdue ?? 0,
    medianDaysLate: late.length ? Math.max(0, Math.round(late[late.length >> 1]!.days)) : 0,
    burden,
    dailyMs: burden * (time?.ms ?? 0),
  }
}

/**
 * Time in the app that was not spent answering cards.
 *
 * The heartbeat in `hooks/useActivity.ts` writes these rows; a session with one
 * beat is a visit of under thirty seconds and contributes nothing, which is
 * correct rather than a rounding error.
 */
export async function appTime(days = 7): Promise<{ appMs: number; reviewMs: number }> {
  const since = Date.now() - days * DAY
  const [app] = await db.select<{ ms: number }>(
    `SELECT SUM(last_seen - started_at) AS ms FROM app_sessions WHERE started_at >= ?`,
    [since],
  )
  const [review] = await db.select<{ ms: number }>(
    `SELECT SUM(duration_ms) AS ms FROM reviews WHERE ts >= ?`,
    [since],
  )
  return { appMs: app?.ms ?? 0, reviewMs: review?.ms ?? 0 }
}

const startOfDay = (ts: number) => new Date(new Date(ts).setHours(0, 0, 0, 0)).getTime()

// ── one deck, as figures a briefing can be written over ───────────────────

export interface DeckFigures {
  deck: string
  target: number
  cards: number
  new: number
  learning: number
  young: number
  mature: number
  suspended: number
  due: number
  overdue: number
  tested: number
  passed: number
  mature_tested: number
  mature_passed: number
  burden: number
  median_answer_ms: number
}

/**
 * Everything about one deck that is worth saying a sentence about.
 *
 * Gathered in one place rather than by filtering the dashboard's queries,
 * because the dashboard's queries answer "across the collection" and every one
 * of them would need the same subdeck recursion bolted on to answer "in here".
 * One function, two statements, and the recursion written once.
 *
 * Subdecks are included — `Anatomy` means `Anatomy` and everything under it,
 * which is what the deck list's own counts mean (repo.ts) and what a person
 * looking at a parent deck is asking about.
 */
export async function deckFigures(deckId: string, sinceDays = 365, now = Date.now()): Promise<DeckFigures | null> {
  const SUB = `WITH RECURSIVE sub(id) AS (
      SELECT ?1 UNION ALL SELECT d.id FROM decks d JOIN sub ON d.parent_id = sub.id
    )`

  const [counts] = await db.select<Omit<DeckFigures, 'tested' | 'passed' | 'mature_tested' | 'mature_passed' | 'median_answer_ms'>>(
    `${SUB}
     SELECT (SELECT name FROM decks WHERE id = ?1) AS deck,
            (SELECT retention_target FROM decks WHERE id = ?1) AS target,
            COUNT(*) AS cards,
            SUM(c.suspended = 0 AND c.state = 'new') AS "new",
            SUM(c.suspended = 0 AND c.state IN ('learning','relearning')) AS learning,
            SUM(c.suspended = 0 AND c.state = 'review' AND c.stability < 21) AS young,
            SUM(c.suspended = 0 AND c.state = 'review' AND c.stability >= 21) AS mature,
            SUM(c.suspended = 1) AS suspended,
            SUM(c.suspended = 0 AND c.due <= ?2) AS due,
            SUM(c.suspended = 0 AND c.state != 'new' AND c.due <= ?2) AS overdue,
            -- SuperMemo's burden: the reviews per day this deck has already
            -- committed you to at a steady state, whatever you do next.
            SUM(CASE WHEN c.suspended = 0 AND c.state = 'review' AND c.stability >= 1
                     THEN 1.0 / c.stability ELSE 0 END) AS burden
       FROM cards c
       JOIN notes n ON n.id = c.note_id
      WHERE ${DECK_OF} IN (SELECT id FROM sub)`,
    [deckId, now],
  )

  if (!counts?.deck) return null

  const [recall] = await db.select<{
    tested: number; passed: number; mature_tested: number; mature_passed: number
  }>(
    `${SUB}, tested AS (${RECALL_TESTS})
     SELECT COUNT(*) AS tested,
            SUM(CASE WHEN t.rating > 1 THEN 1 ELSE 0 END) AS passed,
            SUM(CASE WHEN t.gap >= ?3 THEN 1 ELSE 0 END) AS mature_tested,
            SUM(CASE WHEN t.gap >= ?3 AND t.rating > 1 THEN 1 ELSE 0 END) AS mature_passed
       FROM tested t
       JOIN cards c ON c.id = t.card_id
       JOIN notes n ON n.id = c.note_id
      WHERE ${DECK_OF} IN (SELECT id FROM sub) AND t.gap >= ?4 AND t.ts >= ?2`,
    // Numbered from one per statement, not shared across the three: node's
    // SQLite refuses a parameter a statement does not use, and the wasm build
    // accepting it anyway is not a promise worth leaning on.
    [deckId, now - sinceDays * DAY, MATURE, DAY],
  )

  // The median, not the mean: one card left open over lunch would drag an
  // average into a number nobody recognises.
  const times = await db.select<{ ms: number }>(
    `${SUB}
     SELECT r.duration_ms AS ms FROM reviews r
       JOIN cards c ON c.id = r.card_id
       JOIN notes n ON n.id = c.note_id
      WHERE ${DECK_OF} IN (SELECT id FROM sub) AND r.ts >= ?2 AND r.duration_ms > 0
      ORDER BY r.duration_ms`,
    [deckId, now - 30 * DAY],
  )

  return {
    ...counts,
    burden: Number((counts.burden ?? 0).toFixed(2)),
    tested: recall?.tested ?? 0,
    passed: recall?.passed ?? 0,
    mature_tested: recall?.mature_tested ?? 0,
    mature_passed: recall?.mature_passed ?? 0,
    median_answer_ms: times.length ? times[times.length >> 1]!.ms : 0,
  }
}
