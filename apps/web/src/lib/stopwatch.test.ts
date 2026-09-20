/**
 * The review clock.
 *
 * What is being defended here is every number on the stats screen. The old
 * implementation was `Date.now() - shownAt`, which credits a lunch break to
 * whichever card happened to be on screen — and one of those in a log moves a
 * deck's mean by a minute. Each test below is a way that used to go wrong.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IDLE_MS, stopwatch } from './stopwatch.ts'

/** A clock we move by hand, so none of this waits on real time. */
function fake(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

test('it counts the time a card was actually in front of you', () => {
  const clock = fake()
  const sw = stopwatch(clock.now)
  clock.advance(4_000)
  assert.equal(sw.elapsed(), 4_000)
  sw.stop()
})

test('it stops after the idle threshold instead of counting the whole gap', () => {
  const clock = fake()
  const sw = stopwatch(clock.now)

  // Somebody reads for a while, then walks away with the tab open.
  clock.advance(10 * 60_000)

  // The grace period is credited — reading without touching anything is still
  // studying — and not one millisecond of the ten minutes after it.
  assert.equal(sw.elapsed(), IDLE_MS)
  sw.stop()
})

test('elapsed() is stable once idle, however late it is read', () => {
  const clock = fake()
  const sw = stopwatch(clock.now)
  clock.advance(60 * 60_000)
  const first = sw.elapsed()
  clock.advance(60 * 60_000)
  assert.equal(sw.elapsed(), first, 'an hour later it still reports the same answer')
  sw.stop()
})

test('a short think is counted in full', () => {
  const clock = fake()
  const sw = stopwatch(clock.now)
  clock.advance(IDLE_MS - 1)
  assert.equal(sw.elapsed(), IDLE_MS - 1, 'just under the threshold is untouched')
  sw.stop()
})

test('stopping twice does not double-count', () => {
  const clock = fake()
  const sw = stopwatch(clock.now)
  clock.advance(3_000)
  sw.stop()
  const after = sw.elapsed()
  clock.advance(5_000)
  sw.stop()
  assert.equal(sw.elapsed(), after)
})

test('a fresh stopwatch per card does not inherit the last one', () => {
  const clock = fake()
  const first = stopwatch(clock.now)
  clock.advance(9_000)
  first.stop()

  const second = stopwatch(clock.now)
  clock.advance(2_000)
  assert.equal(second.elapsed(), 2_000)
  second.stop()
})
