/**
 * The memory model's derived numbers.
 *
 * Two of these are guarding against a specific wrong answer that would look
 * entirely plausible on a dashboard: a half-life quoted from the wrong FSRS
 * version, and a leech rule that suspends healthy cards.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  daysUntil, failureSurprise, halfLifeMultiplier, replayWithRetrievability,
  retrievability, type PredictedReview,
} from './memory.ts'

test('stability is defined as the days until recall falls to 90%', () => {
  for (const s of [1, 10, 100]) {
    assert.ok(Math.abs(retrievability(s, s) - 0.9) < 1e-9, `R(${s}, ${s}) should be 0.9`)
  }
})

test('recall decays with time and never goes backwards', () => {
  let previous = 1
  for (const t of [0, 1, 5, 10, 20, 50, 100, 900]) {
    const r = retrievability(10, t)
    assert.ok(r <= previous + 1e-12, `R must not rise between ${t} days and the last`)
    assert.ok(r > 0 && r <= 1)
    previous = r
  }
})

test('a card never reviewed is not remembered', () => {
  assert.equal(retrievability(0, 5), 0)
})

test('daysUntil inverts the curve', () => {
  const s = 12
  for (const target of [0.95, 0.9, 0.8, 0.5]) {
    const t = daysUntil(s, target)
    assert.ok(Math.abs(retrievability(s, t) - target) < 1e-6, `round trip at ${target}`)
  }
  assert.ok(Math.abs(daysUntil(s, 0.9) - s) < 1e-6, 'R = 0.9 lands exactly on stability')
})

test('the half-life multiplier is the one for the decay we actually ship', () => {
  // 12.79 is the FSRS-4.5/5 figure (decay −0.5) and is quoted everywhere. This
  // app runs stock FSRS-6, where it is ~90. Hard-coding the famous number would
  // under-report every durability figure sevenfold.
  const m = halfLifeMultiplier()
  assert.ok(m > 50, `expected the FSRS-6 multiplier, got ${m}`)
  assert.ok(Math.abs(retrievability(1, m) - 0.5) < 1e-6)
})

const card = { id: 'n1:0', note_id: 'n1', ord: 0 }
const DAY = 86_400_000
const review = (n: number, rating: number, day: number) =>
  ({ id: `r${n}`, card_id: card.id, ts: 1_700_000_000_000 + day * DAY, rating, duration_ms: 4000 }) as never

test('replay records what the model believed before each answer', () => {
  const { reviews } = replayWithRetrievability(
    card,
    [review(1, 3, 0), review(2, 3, 3), review(3, 1, 20)],
    0.9,
    1_700_000_000_000,
  )

  assert.equal(reviews.length, 3)
  assert.equal(reviews[0]!.predicted, 0, 'a first sight was never predicted')
  assert.ok(reviews[1]!.predicted > 0 && reviews[1]!.predicted < 1)
  assert.equal(reviews[2]!.recalled, false, 'Again is the only failure')
  assert.ok(reviews[2]!.elapsedDays > 15, 'the gap before the lapse is recorded')
})

/** Reviews all predicted at the same R, `fails` of which went wrong. */
const runs = (n: number, fails: number, predicted = 0.9): PredictedReview[] =>
  Array.from({ length: n }, (_, i) => ({
    ts: i, rating: i < fails ? 1 : 3, predicted, recalled: i >= fails,
    stability: 10, elapsedDays: 10,
  }))

test('the leech test tells a healthy card from a hopeless one', () => {
  // The case Anki's threshold-of-8 gets wrong: at 90% retention, eight failures
  // in eighty reviews is precisely what the scheduler is aiming for. Today's
  // rule suspends this card.
  assert.ok(failureSurprise(runs(80, 8)) > 0.4, 'eight in eighty is normal')

  // The same eight failures, in eleven reviews.
  assert.ok(failureSurprise(runs(11, 8)) < 1e-4, 'eight in eleven is not')

  // And it fires early, rather than waiting for a count to accumulate.
  assert.ok(failureSurprise(runs(2, 2)) <= 0.01, 'two straight failures is already improbable')
})

test('surprise falls as failures mount and is never out of range', () => {
  let previous = 1
  for (const fails of [0, 1, 2, 4, 8]) {
    const p = failureSurprise(runs(20, fails))
    assert.ok(p <= previous + 1e-12, 'more failures cannot be less surprising')
    assert.ok(p >= 0 && p <= 1)
    previous = p
  }
})

test('a card with no scored reviews is never a leech', () => {
  assert.equal(failureSurprise([]), 1)
  assert.equal(failureSurprise(runs(3, 3, 0)), 1, 'first sights alone prove nothing')
})

test('the same failure count is more damning on an easy card', () => {
  const onEasy = failureSurprise(runs(20, 4, 0.97))
  const onHard = failureSurprise(runs(20, 4, 0.7))
  assert.ok(onEasy < onHard, 'failing what you were expected to know is the worse signal')
})
