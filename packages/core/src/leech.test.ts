/** Leech verdicts and, the point of the exercise, the reason attached to them. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_LEECH, detectLeech, recallTests } from './leech.ts'
import type { Review } from './types.ts'

const DAY = 86_400_000
const T0 = Date.UTC(2026, 0, 1)
const card = { id: 'n1:0', ord: 0 }

let seq = 0
const rv = (dayOffset: number, rating: 1 | 2 | 3 | 4, ms = 6000): Review => ({
  id: `r${seq++}`,
  card_id: 'n1:0',
  ts: T0 + dayOffset * DAY,
  rating,
  duration_ms: ms,
})

/** n failures at `gapDays` apart, each preceded by a pass so the gap is real. */
function failing(n: number, gapDays: number, failMs = 6000, passMs = 6000): Review[] {
  const out: Review[] = []
  for (let i = 0; i < n; i++) {
    out.push(rv(i * gapDays * 2, 3, passMs))
    out.push(rv(i * gapDays * 2 + gapDays, 1, failMs))
  }
  return out
}

test('same-day relearning steps are not recall tests', () => {
  const history: Review[] = [
    rv(0, 1),
    { ...rv(0, 1), ts: T0 + 600_000 },
    { ...rv(0, 3), ts: T0 + 1_200_000 },
    rv(5, 1),
  ]
  // Only the answer five days later followed a gap worth calling a test.
  assert.equal(recallTests(history).length, 1)
  assert.equal(detectLeech(card, history).lapses, 1)
})

test('the threshold is the log, not cards.lapses', () => {
  assert.equal(detectLeech(card, failing(7, 2)).leech, false)
  assert.equal(detectLeech(card, failing(8, 2)).leech, true)
  assert.equal(detectLeech(card, failing(4, 2), [], { threshold: 4 }).leech, true)
})

test('it fires at the threshold, then every half threshold — never on every lapse', () => {
  const fires = (n: number) => detectLeech(card, failing(n, 2)).fires
  assert.equal(fires(8), true)
  assert.equal(fires(9), false)
  assert.equal(fires(11), false)
  assert.equal(fires(12), true) // 8 + 4
  assert.equal(DEFAULT_LEECH.threshold, 8)
})

test('the action is the deck option, and nothing happens below the threshold', () => {
  const s = detectLeech(card, failing(8, 2))
  assert.deepEqual([s.tag, s.suspend, s.flag], ['leech', true, null])

  const f = detectLeech(card, failing(8, 2), [], { action: 'flag', flag: 2 })
  assert.deepEqual([f.tag, f.suspend, f.flag], ['leech', false, 2])

  const clean = detectLeech(card, failing(2, 2))
  assert.deepEqual([clean.tag, clean.suspend, clean.flag, clean.reason], [null, false, null, null])
})

test('a sibling that fails as often is the reason, and it names the card', () => {
  const v = detectLeech(card, failing(8, 2), [
    { id: 'n1:1', ord: 1, history: failing(6, 2).map((r) => ({ ...r, card_id: 'n1:1' })) },
  ])
  assert.equal(v.reason?.code, 'confused-with-sibling')
  assert.equal(v.reason?.sibling, 'n1:1')
  assert.match(v.reason!.text, /card 2 of the same note has 6/)

  // A sibling that is fine does not get blamed.
  const ok = detectLeech(card, failing(8, 2), [
    { id: 'n1:1', ord: 1, history: failing(1, 2).map((r) => ({ ...r, card_id: 'n1:1' })) },
  ])
  assert.notEqual(ok.reason?.code, 'confused-with-sibling')
})

test('failing fast and passing slow is rated as guessing', () => {
  const v = detectLeech(card, failing(8, 30, 1800, 9000))
  assert.equal(v.reason?.code, 'answered-too-fast')
  assert.match(v.reason!.text, /1\.8s/)
})

test('short gaps mean the card is ambiguous; long gaps mean the target is wrong', () => {
  assert.equal(detectLeech(card, failing(8, 1)).reason?.code, 'never-retained')
  assert.equal(detectLeech(card, failing(8, 30)).reason?.code, 'fails-after-gaps')
})
