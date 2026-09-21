/**
 * The dashboard's SQL, run against a real SQLite.
 *
 * `node:sqlite` is the same engine as the wasm build in the worker, so the
 * window function, the day-gap rule and the tag rollup are checked for real
 * rather than asserted about. The worker RPC is swapped out for the in-memory
 * database — nothing here mocks a *result*, only the transport.
 *
 *   node --experimental-strip-types --test apps/web/src/db/queries/stats.test.ts
 */
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { MIGRATIONS } from '@recall/core'
import { db } from '../client.ts'
import * as stats from './stats.ts'

const DAY = 86_400_000
const NOW = Date.now()
/** Yesterday noon-ish, so every crafted gap stays inside its own local day. */
const ago = (d: number) => NOW - d * DAY

const sqlite = new DatabaseSync(':memory:')

/**
 * `node:sqlite` refuses a positional array against `?1`-style placeholders and
 * wants them keyed by index; the wasm worker takes either. Same values, same
 * order — only the calling convention differs.
 */
function query(sql: string, params: unknown[] = []): Record<string, unknown>[] {
  const st = sqlite.prepare(sql)
  const vs = params as SQLInputValue[]
  return /\?\d/.test(sql)
    ? st.all(Object.fromEntries(vs.map((v, i) => [String(i + 1), v] as const)))
    : st.all(...vs)
}

before(() => {
  for (const m of MIGRATIONS) sqlite.exec(m)

  db.select = async <T,>(sql: string, params: unknown[] = []) => query(sql, params) as T[]
  db.run = async (sql: string, params: unknown[] = []) => void query(sql, params)
  db.batch = async (batch: { sql: string; params?: unknown[] }[]) => {
    for (const s of batch) query(s.sql, s.params)
  }

  sqlite.exec(`
    INSERT INTO decks (id, parent_id, name, retention_target, new_per_day)
      VALUES ('d1', NULL, 'Thorax', 0.9, 20);
    INSERT INTO note_types (id, name, fields, templates, sort_field)
      VALUES ('nt', 'Basic', '["Front","Back"]', '[]', 0);
    INSERT INTO notes (id, note_type, deck_id, fields, tags, guid, updated_at)
      VALUES ('n1', 'nt', 'd1', '{"Front":"<b>Mitral</b> valve","Back":"bicuspid"}',
              'anatomy::thorax::valves anatomy::thorax', 'g1', 0),
             ('n2', 'nt', 'd1', '{"Front":"Aspirin","Back":"COX"}', 'pharm', 'g2', 0);
    INSERT INTO cards (id, note_id, ord, due, state, lapses)
      VALUES ('n1:0', 'n1', 0, ${NOW + 2 * DAY}, 'review', 9),
             ('n1:1', 'n1', 1, ${NOW + 5 * DAY}, 'review', 6),
             ('n2:0', 'n2', 0, ${NOW + 2 * DAY}, 'review', 0);
  `)

  let n = 0
  const review = (card: string, daysAgo: number, rating: number, ms = 6000) =>
    sqlite.exec(
      `INSERT INTO reviews (id, card_id, ts, rating, duration_ms)
       VALUES ('r${n++}', '${card}', ${ago(daysAgo)}, ${rating}, ${ms})`,
    )

  // n1:0 — ten failed recall tests at two-day gaps, plus a same-day relearning
  // burst that must NOT be counted as extra tests.
  for (let i = 0; i < 10; i++) {
    review('n1:0', 60 - i * 4, 3)
    review('n1:0', 58 - i * 4, 1)
    review('n1:0', 58 - i * 4 - 0.005, 1) // ten minutes later
  }
  // n1:1 — its reverse, failing nearly as often. This is the sibling reason.
  for (let i = 0; i < 6; i++) {
    review('n1:1', 60 - i * 4, 3)
    review('n1:1', 58 - i * 4, 1)
  }
  // n2:0 — healthy: twelve passes at long gaps, one mature failure.
  for (let i = 0; i < 12; i++) review('n2:0', 300 - i * 25, 3)
  review('n2:0', 1, 1)
})

test('a recall test is an answer a day or more after the last one', async () => {
  const rows = await db.select<{ card_id: string; tests: number }>(
    `WITH tested AS (${stats.RECALL_TESTS})
     SELECT card_id, COUNT(*) AS tests FROM tested
      WHERE gap >= ${DAY} GROUP BY card_id ORDER BY card_id`,
  )
  // 10 passes + 10 failures = 20 answers with a real gap, minus the very first
  // (no predecessor) = 19. The ten same-day repeats are excluded.
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { card_id: 'n1:0', tests: 19 },
    { card_id: 'n1:1', tests: 11 },
    { card_id: 'n2:0', tests: 12 },
  ])
})

test('true retention is per deck and sits beside the target that was asked for', async () => {
  const [d] = await stats.retention()
  assert.equal(d!.deck, 'Thorax')
  assert.equal(d!.target, 0.9)
  // 19 + 11 + 12 tests; the failures are the 10 + 6 crafted lapses plus n2's one.
  assert.equal(d!.tested, 42)
  assert.equal(d!.passed, 42 - 17)
  // Mature = past 21 days. Only n2:0's 25-day gaps qualify.
  assert.equal(d!.mature_tested, 12)
  assert.ok(d!.passed / d!.tested < d!.target, 'this collection is under target')
})

test('tags roll up the :: tree, and a note in two branches counts once', async () => {
  const topics = await stats.worstTopics(365, 1)
  const by = new Map(topics.map((t) => [t.tag, t]))

  assert.ok(by.has('anatomy'), 'the parent exists without being tagged directly')
  assert.equal(by.get('anatomy')!.depth, 0)
  assert.equal(by.get('anatomy::thorax::valves')!.depth, 2)

  // n1's two tags share the `anatomy` and `anatomy::thorax` prefixes; the
  // rollup must not double-count its cards into either.
  assert.equal(by.get('anatomy')!.cards, 2)
  assert.equal(by.get('anatomy')!.tested, by.get('anatomy::thorax')!.tested)
  assert.equal(by.get('anatomy')!.tested, 30)

  // Worst first, and `pharm` is the healthy one.
  assert.ok(by.get('anatomy')!.failed / by.get('anatomy')!.tested > 0.4)
  assert.equal(topics.at(-1)!.tag, 'pharm')
})

test('the forecast folds overdue into today and covers every day asked for', async () => {
  sqlite.exec(`UPDATE cards SET due = ${NOW - 9 * DAY} WHERE id = 'n2:0'`)
  const days = await stats.forecast(14)
  assert.equal(days.length, 14)
  assert.deepEqual(days.map((d) => d.day), [...Array(14).keys()])
  assert.equal(days[0]!.due, 1, 'the overdue card lands on day 0, not on a negative day')
  assert.equal(days[2]!.due, 1)
  assert.equal(days[5]!.due, 1)
  sqlite.exec(`UPDATE cards SET due = ${NOW + 2 * DAY} WHERE id = 'n2:0'`)
})

test('the streak counts back from today and is not broken by an unstudied today', () => {
  const day = (reviews: number) => ({ date: 0, reviews, passed: reviews })
  assert.equal(stats.streak([day(1), day(1), day(1)]), 3)
  assert.equal(stats.streak([day(1), day(1), day(0)]), 2, 'today not studied yet')
  assert.equal(stats.streak([day(1), day(0), day(1)]), 1)
  assert.equal(stats.streak([day(0), day(0), day(0)]), 0)
})

test('the day buckets and the hour buckets both come back fully populated', async () => {
  const days = await stats.daily(90)
  assert.equal(days.length, 90)
  assert.ok(days.some((d) => d.reviews > 0))
  assert.equal(days.at(-1)!.reviews, 0, 'nothing was reviewed today in this fixture')

  const hours = await stats.byHour(365)
  assert.deepEqual(hours.map((h) => h.hour), [...Array(24).keys()])
  assert.equal(hours.reduce((s, h) => s + h.reviews, 0), 55)
})

test('a day that is not 24 hours long is still one day', async () => {
  // The bug this replaced: both charts bucketed in SQL, `daily()` by dividing
  // by 86,400,000 from local midnight and `byHour()` by applying *today's* UTC
  // offset to every historical timestamp. Two days a year are 23 or 25 hours
  // long, so every bucket after a change was shifted and a year of hour-of-day
  // data was relabelled twice a year. 10d's briefing now reads both.
  const boundaries = stats.dayBoundaries(400)

  assert.equal(boundaries.length, 400)
  for (let i = 1; i < boundaries.length; i++) {
    const gap = boundaries[i]! - boundaries[i - 1]!
    assert.ok(gap >= 23 * 3_600_000 && gap <= 25 * 3_600_000, `day ${i} is a plausible length`)
    assert.equal(new Date(boundaries[i]!).getHours(), 0, 'every boundary is a local midnight')
  }

  // And somewhere in 400 days there is at least one day that is not 24 hours,
  // wherever this test runs — unless the host has no DST at all, which is a
  // legitimate outcome rather than a failure.
  const lengths = new Set(boundaries.slice(1).map((b, i) => b - boundaries[i]!))
  assert.ok(lengths.size <= 3, 'at most: a short day, a long day, and the ordinary one')
})

test('a review is counted on the local day it happened, not a fixed slice', () => {
  const boundaries = stats.dayBoundaries(3)
  const yesterdayNoon = boundaries[1]! + 12 * 3_600_000

  const counts = stats.bucketByDay(
    [{ ts: yesterdayNoon, rating: 3 }, { ts: boundaries[1]!, rating: 1 }],
    boundaries,
  )

  assert.equal(counts[1]!.reviews, 2, 'both land on yesterday')
  assert.equal(counts[1]!.passed, 1)
  assert.equal(counts[0]!.reviews, 0)
  assert.equal(counts[2]!.reviews, 0)
})

test('the hour is the hour that was on the clock at the time', () => {
  // Not today's offset applied to an old timestamp. Two reviews six months
  // apart at the same wall-clock hour belong in the same bucket.
  const winter = new Date(2026, 0, 15, 8, 30).getTime()
  const summer = new Date(2026, 6, 15, 8, 30).getTime()

  const hours = stats.bucketByHour([{ ts: winter, rating: 3 }, { ts: summer, rating: 3 }])

  assert.equal(hours[8]!.reviews, 2, 'both are hour 8 whatever the clocks did in between')
  assert.equal(hours.reduce((s, h) => s + h.reviews, 0), 2)
})

test('a leech arrives with the reason, and the reason names the sibling', async () => {
  const rows = await stats.leeches()

  // Both sides of note n1 are leeches, and that is the finding: ten failures on
  // one face and six on the other, at two-day gaps the scheduler expected them
  // to survive. The old lapse threshold of 8 saw only the first, which is
  // precisely the card whose *sibling* is the reason it keeps failing.
  assert.deepEqual(rows.map((r) => r.card_id).sort(), ['n1:0', 'n1:1'])

  // The healthy card is the regression guard: twelve passes and one mature
  // failure is a card behaving exactly as designed at 90% retention, and a
  // count-based rule that flagged it would suspend somebody's working card.
  assert.ok(!rows.some((r) => r.card_id === 'n2:0'), 'a card failing as predicted is not a leech')

  const l = rows.find((r) => r.card_id === 'n1:0')
  assert.equal(l!.deck, 'Thorax')
  assert.equal(l!.preview, 'Mitral valve', 'markup stripped for the list')
  // Ten, from the log — not the twenty a same-day relearning burst would give,
  // and not the nine the `cards.lapses` cache happens to hold.
  assert.equal(l!.verdict.lapses, 10)
  assert.equal(l!.verdict.reason?.code, 'confused-with-sibling')
  assert.equal(l!.verdict.reason?.sibling, 'n1:1')
  assert.ok(l!.verdict.surprise! < 0.01, 'flagged because the failures were improbable')
})

test('the scheduler check judges a card against what was predicted for it', async () => {
  // The healthy card first: one mature failure in thirteen reviews at 90%
  // retention is the scheduler working, not a leech. This is the assertion that
  // fails the moment anyone puts a lapse count back in charge.
  assert.equal(await stats.checkLeech('n2:0', 'n2'), null, 'a card failing as predicted is left alone')

  const verdict = await stats.checkLeech('n1:0', 'n1')
  assert.equal(verdict?.leech, true)
  assert.ok(verdict!.surprise! < 0.01, 'ten failures at two-day gaps are not chance')
  assert.equal(verdict?.reason?.code, 'confused-with-sibling')

  // Firing steps, so an unsuspended leech is not re-suspended on its very next
  // failure. Whichever way this call lands, the write must match the verdict.
  const [note] = await db.select<{ tags: string }>(`SELECT tags FROM notes WHERE id = 'n1'`)
  assert.equal(
    note!.tags.split(' ').includes('leech'),
    verdict!.fires,
    'the tag is written exactly when the verdict fires',
  )

  sqlite.exec(`UPDATE notes SET tags = 'anatomy::thorax::valves anatomy::thorax' WHERE id = 'n1'`)
  sqlite.exec(`UPDATE cards SET suspended = 0 WHERE id = 'n1:0'`)
})

test('applying a leech writes the reserved tag once and suspends the card', async () => {
  const l = (await stats.leeches()).find((r) => r.card_id === 'n1:0')
  await stats.applyLeech(l!)
  await stats.applyLeech(l!) // idempotent — a second run must not double-tag

  const [note] = await db.select<{ tags: string }>(`SELECT tags FROM notes WHERE id = 'n1'`)
  assert.equal(note!.tags.split(' ').filter((t) => t === 'leech').length, 1)
  const [card] = await db.select<{ suspended: number; state_updated_at: number }>(
    `SELECT suspended, state_updated_at FROM cards WHERE id = 'n1:0'`,
  )
  assert.equal(card!.suspended, 1)
  assert.ok(card!.state_updated_at > 0, 'a synced decision needs its clock bumped')
})

test('answering a card buries its siblings, and rule 4 sees it immediately', async () => {
  sqlite.exec(`UPDATE cards SET suspended = 0 WHERE id = 'n1:0'`)
  const buried = await stats.burySiblings('n1:0', 'n1', NOW)
  assert.deepEqual(buried, ['n1:1'])

  // The filter the badge, the session counter and nextCard all carry.
  const [visible] = await db.select<{ n: number }>(
    `SELECT COUNT(*) AS n FROM cards
      WHERE suspended = 0 AND (buried_until IS NULL OR buried_until <= ?)`,
    [NOW],
  )
  assert.equal(visible!.n, 2, 'the buried sibling leaves the count the moment it is buried')

  assert.deepEqual(await stats.burySiblings('n1:0', 'n1', NOW), [], 'already buried')
  assert.deepEqual(await stats.burySiblings('n2:0', 'n2', NOW), [], 'a note with one card')
})

test('the model is scored against itself, and the memory curve starts empty', async () => {
  // The replay is the app's one structural advantage over Anki, so the risk is
  // not the arithmetic — `memory.test.ts` covers that — it is the plumbing:
  // grouping the log by card, dropping first sights, and walking the day
  // boundaries without smearing a card's stability backwards in time.
  const model = await stats.memoryModel(400, 3650)

  // 30 + 12 + 13 answers, less one first sight per card: a card being seen for
  // the first time was never predicted and cannot be a calibration failure.
  assert.equal(model.error.n, 52)
  assert.ok(model.calibration.length > 0)
  for (const b of model.calibration) {
    assert.ok(b.predicted > b.from - 1e-9 && b.predicted <= b.to + 1e-9, 'a bin holds its own range')
    assert.ok(b.observed >= 0 && b.observed <= 1)
  }

  // This fixture is crafted to fail far more than predicted, so the scheduler
  // must read as optimistic. A negative bias here would mean the sign is
  // inverted, which is the one bug on this chart nobody would notice.
  assert.ok(model.error.bias > 0, `expected an optimistic bias, got ${model.error.bias}`)

  assert.equal(model.memorised.length, 400)
  // The oldest review in the fixture is 300 days old, so a year and a bit ago
  // nothing was held. A non-zero here means stability leaked backwards past the
  // review that created it.
  assert.equal(model.memorised[0]!.remembered, 0)
  assert.equal(model.memorised[0]!.cards, 0)

  const today = model.memorised.at(-1)!
  assert.ok(today.remembered > 0 && today.cards > 0, 'something is held today')
  assert.ok(today.remembered <= today.cards, 'Σ R can never exceed the cards it sums over')
})

test('a deck brief counts its subdecks, and a sibling deck is not one', async () => {
  // The rollup is the whole risk here: `Anatomy` on the deck list means
  // `Anatomy` and everything under it, and a briefing that quietly meant only
  // the parent's own cards would describe a deck nobody is looking at.
  const before = await stats.deckFigures('d1')
  assert.ok(before)

  sqlite.exec(`
    INSERT INTO decks (id, parent_id, name, retention_target, new_per_day)
      VALUES ('d1a', 'd1', 'Valves', 0.9, 20),
             ('d9', NULL, 'Unrelated', 0.9, 20);
    INSERT INTO notes (id, note_type, deck_id, fields, tags, guid, updated_at)
      VALUES ('n3', 'nt', 'd1a', '{"Front":"Aortic","Back":"semilunar"}', '', 'g3', 0),
             ('n9', 'nt', 'd9', '{"Front":"Nothing","Back":"here"}', '', 'g9', 0);
    INSERT INTO cards (id, note_id, ord, due, state, stability)
      VALUES ('n3:0', 'n3', 0, ${NOW + DAY}, 'review', 30),
             ('n9:0', 'n9', 0, ${NOW + DAY}, 'review', 30);
    INSERT INTO reviews (id, card_id, ts, rating, duration_ms) VALUES
      ('rd1', 'n3:0', ${ago(9)}, 3, 4000),
      ('rd2', 'n3:0', ${ago(5)}, 3, 8000),
      ('rd3', 'n9:0', ${ago(9)}, 1, 4000),
      ('rd4', 'n9:0', ${ago(5)}, 1, 4000);
  `)

  const child = await stats.deckFigures('d1a')
  assert.ok(child)
  assert.equal(child.deck, 'Valves')
  assert.equal(child.cards, 1)
  // The first answer has no predecessor, so only the second is a recall test.
  assert.equal(child.tested, 1)
  assert.equal(child.passed, 1)
  assert.equal(child.median_answer_ms, 8000)

  const parent = await stats.deckFigures('d1')
  assert.ok(parent)
  assert.equal(parent.cards, before.cards + 1, 'the subdeck is counted in')
  assert.equal(parent.tested, before.tested + 1)
  // `Unrelated` is a root deck beside `d1`, not under it.
  assert.equal(parent.cards < before.cards + 2, true, 'a sibling deck is not a subdeck')

  assert.equal(await stats.deckFigures('nope'), null)
})
