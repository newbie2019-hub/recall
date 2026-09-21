import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newCard, applyReview, replayReviews, previewIntervals } from './scheduler.ts'
import { Rating } from './types.ts'
import type { Review, RatingValue } from './types.ts'

const DAY = 86_400_000
const T0 = Date.UTC(2026, 0, 1)
const R = 0.9

test('a new card is due immediately and has no reps', () => {
  const c = newCard('c1', 'n1', 0, T0)
  assert.equal(c.state, 'new')
  assert.equal(c.reps, 0)
  assert.ok(c.due <= T0)
})

test('Again on a review card counts a lapse; Easy schedules further out than Good', () => {
  const base = newCard('c1', 'n1', 0, T0)
  const good = applyReview(base, Rating.Good, T0, R)
  const easy = applyReview(base, Rating.Easy, T0, R)
  assert.ok(easy.due > good.due, 'Easy must schedule later than Good')

  const mature = applyReview(good, Rating.Good, good.due, R)
  const lapsed = applyReview(mature, Rating.Again, mature.due, R)
  assert.equal(lapsed.lapses, mature.lapses + 1)
  assert.equal(lapsed.state, 'relearning')
})

test('previewIntervals is monotonic across the four buttons', () => {
  const c = applyReview(newCard('c1', 'n1', 0, T0), Rating.Good, T0, R)
  const p = previewIntervals(c, c.due, R)
  assert.ok(p[1] <= p[2] && p[2] <= p[3] && p[3] <= p[4], JSON.stringify(p))
})

/**
 * The one that matters: `cards` is a derived cache, so replaying the log must
 * reproduce it exactly. If this breaks, sync and history import are both wrong.
 */
test('replayReviews reproduces incrementally-applied state exactly', () => {
  const ratings: RatingValue[] = [3, 3, 1, 3, 2, 3, 4, 3]

  let live = newCard('c1', 'n1', 0, T0)
  const log: Review[] = []
  let t = T0
  ratings.forEach((rating, i) => {
    t = Math.max(t + DAY, live.due)
    log.push({ id: `r${i}`, card_id: 'c1', ts: t, rating, duration_ms: 1000 })
    live = applyReview(live, rating, t, R)
  })

  const rebuilt = replayReviews({ id: 'c1', note_id: 'n1', ord: 0 }, log, R, T0)

  assert.deepEqual(rebuilt, live)
})

test('replayReviews is order-independent and deterministic', () => {
  const log: Review[] = [
    { id: 'r2', card_id: 'c1', ts: T0 + 3 * DAY, rating: 3, duration_ms: 0 },
    { id: 'r0', card_id: 'c1', ts: T0 + 1 * DAY, rating: 3, duration_ms: 0 },
    { id: 'r1', card_id: 'c1', ts: T0 + 2 * DAY, rating: 1, duration_ms: 0 },
  ]
  const a = replayReviews({ id: 'c1', note_id: 'n1', ord: 0 }, log, R, T0)
  const b = replayReviews({ id: 'c1', note_id: 'n1', ord: 0 }, [...log].reverse(), R, T0)
  assert.deepEqual(a, b)
})

// ── scheduling overrides (migration 10) ───────────────────────────────────
//
// Two corrections layered on the log without editing it. What every test here
// is really guarding is that the log stays the source of truth: clear the
// overrides and the card must be exactly what its history says it is.

const log8 = (): Review[] =>
  [3, 3, 1, 3, 2, 3, 4, 3].map((rating, i) => ({
    id: `r${i}`, card_id: 'c1', ts: T0 + (i + 1) * DAY, rating: rating as RatingValue,
    duration_ms: 1000,
  }))

const replay = (log: Review[], override = {}) =>
  replayReviews({ id: 'c1', note_id: 'n1', ord: 0 }, log, R, T0, override)

test('no override replays exactly as before', () => {
  assert.deepEqual(replay(log8(), {}), replay(log8()))
})

test('a due override moves the date and nothing else', () => {
  const plain = replay(log8())
  const picked = replay(log8(), { due_override: T0 + 99 * DAY })

  assert.equal(picked.due, T0 + 99 * DAY)
  // Stability and difficulty are what the model learned from real answers.
  // Choosing when to see a card next is not a claim about how well it is known,
  // so everything except `due` has to come through untouched.
  assert.deepEqual({ ...picked, due: plain.due }, plain)
})

test('a forget puts the card back to new without touching the log', () => {
  const log = log8()
  const forgotten = replay(log, { forgotten_at: T0 + 100 * DAY })

  assert.equal(forgotten.state, 'new')
  assert.equal(forgotten.reps, 0)
  assert.equal(forgotten.lapses, 0)
  assert.equal(log.length, 8, 'the log is append-only and must not be edited')

  // And it is genuinely reversible: drop the override and the whole history is
  // still there to rebuild from.
  assert.deepEqual(replay(log), replay(log8()))
})

test('a forget keeps the answers that came after it', () => {
  // Forget halfway, then answer twice more. Those two are the card's whole
  // history now — a forget is a new beginning, not a deletion.
  const log = log8()
  const cut = log[3]!.ts
  const after = replay(log, { forgotten_at: cut })
  const only = replay(log.filter((r) => r.ts > cut))

  assert.deepEqual(after, only)
  assert.equal(after.reps, 4)
})

test('a forgotten card is reborn when it was forgotten, not when it was made', () => {
  // Starting the replay at T0 would hand FSRS a brand-new card whose first
  // interval is measured from a year ago, and it would come back instantly due.
  const cut = T0 + 300 * DAY
  const card = replay(log8(), { forgotten_at: cut })
  assert.ok(card.due >= cut, `a card forgotten at ${cut} is not due at ${card.due}`)
})

test('both at once: the date wins, and it is the forgotten card being dated', () => {
  const cut = T0 + 100 * DAY
  const both = replay(log8(), { forgotten_at: cut, due_override: cut + 5 * DAY })
  assert.equal(both.due, cut + 5 * DAY)
  assert.equal(both.state, 'new')
})

test('a null override is the same as no override at all', () => {
  // The columns are nullable and the row always has them, so the common case is
  // `{ due_override: null, forgotten_at: null }` rather than `{}`.
  assert.deepEqual(replay(log8(), { due_override: null, forgotten_at: null }), replay(log8()))
})

test('an override on a card with no history still schedules it', () => {
  const fresh = replay([], { due_override: T0 + 7 * DAY })
  assert.equal(fresh.due, T0 + 7 * DAY)
  assert.equal(fresh.state, 'new')
})
