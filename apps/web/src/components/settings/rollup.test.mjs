// node --test apps/web/src/components/settings/rollup.test.mjs
//
// `.mjs` importing the `.ts` directly: apps/web carries no test runner and no
// @types/node, so a `.test.ts` in `src` would break `tsc -b` for the build.
import test from 'node:test'
import assert from 'node:assert/strict'
import { formatBytes, rollUp } from './rollup.ts'

const node = (id, parent_id, notes, cards, bytes) => ({ id, parent_id, notes, cards, bytes })

test('a parent carries its whole subtree', () => {
  const totals = rollUp([
    node('anatomy', null, 1, 2, 100),
    node('heart', 'anatomy', 3, 6, 200),
    node('valves', 'heart', 5, 10, 400),
  ])
  assert.deepEqual(totals.get('valves'), { notes: 5, cards: 10, bytes: 400 })
  assert.deepEqual(totals.get('heart'), { notes: 8, cards: 16, bytes: 600 })
  assert.deepEqual(totals.get('anatomy'), { notes: 9, cards: 18, bytes: 700 })
})

test('siblings do not bleed into each other', () => {
  const totals = rollUp([
    node('root', null, 0, 0, 0),
    node('a', 'root', 1, 1, 10),
    node('b', 'root', 2, 2, 20),
  ])
  assert.deepEqual(totals.get('a'), { notes: 1, cards: 1, bytes: 10 })
  assert.deepEqual(totals.get('root'), { notes: 3, cards: 3, bytes: 30 })
})

test('a cycle terminates instead of hanging the screen', () => {
  const totals = rollUp([node('a', 'b', 1, 1, 1), node('b', 'a', 1, 1, 1)])
  assert.deepEqual(totals.get('a'), { notes: 2, cards: 2, bytes: 2 })
})

test('formatBytes', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(999), '999 B')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(20 * 1024 * 1024), '20 MB')
})
