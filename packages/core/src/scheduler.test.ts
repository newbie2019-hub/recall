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
