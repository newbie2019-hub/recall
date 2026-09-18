/**
 * The clock maths, which is the only part of the timer that can be wrong
 * silently. Everything else is a button.
 *
 *   node --experimental-strip-types --test apps/web/src/hooks/usePomodoro.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { endsAt, formatClock, progressOf, remainingMs } from './usePomodoro.ts'

const block = { started_at: 1_000_000, planned_ms: 25 * 60_000 }

test('remaining comes from the wall clock, not from elapsed ticks', () => {
  assert.equal(remainingMs(block, block.started_at), 25 * 60_000)
  assert.equal(remainingMs(block, block.started_at + 60_000), 24 * 60_000)

  // The case a tick counter gets wrong: the tab was throttled or asleep for
  // twenty minutes and fired almost no timers. The block is still 20 minutes
  // older, and nothing here counted anything.
  assert.equal(remainingMs(block, block.started_at + 20 * 60_000), 5 * 60_000)
})

test('an overrun block clamps at zero rather than going negative', () => {
  assert.equal(remainingMs(block, block.started_at + 99 * 60_000), 0)
  assert.equal(progressOf(block, block.started_at + 99 * 60_000), 1)
})

test('progress spans the block', () => {
  assert.equal(progressOf(block, block.started_at), 0)
  assert.equal(progressOf(block, block.started_at + 12.5 * 60_000), 0.5)
})

test('endsAt is the planned end, independent of when it is asked', () => {
  assert.equal(endsAt(block), block.started_at + 25 * 60_000)
})

test('the clock rounds up, so a fresh block reads 25:00', () => {
  assert.equal(formatClock(25 * 60_000), '25:00')
  assert.equal(formatClock(24 * 60_000 + 59_999), '25:00')
  assert.equal(formatClock(61_000), '1:01')
  assert.equal(formatClock(999), '0:01')
  assert.equal(formatClock(0), '0:00')
})
