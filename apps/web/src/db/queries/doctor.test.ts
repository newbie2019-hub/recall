/**
 * The doctor's cache key.
 *
 * `fingerprint` is the only judgement in this module and it decides something
 * with a cost attached: a fingerprint that never changes means somebody reads a
 * criticism of a sentence they already rewrote, and one that changes too
 * eagerly means paying to re-grade a collection because a field order moved.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fingerprint } from './doctor.ts'

test('the same fields give the same fingerprint', () => {
  const a = { Front: 'Mitral valve', Back: 'Left AV valve' }
  assert.equal(fingerprint(a), fingerprint({ ...a }))
})

test('key order does not change it', () => {
  // A note round-tripped through JSON, sync or a Y.Map comes back with its keys
  // in a different order. Re-grading a whole collection over that is a bill.
  assert.equal(
    fingerprint({ Front: 'a', Back: 'b' }),
    fingerprint({ Back: 'b', Front: 'a' }),
  )
})

test('editing a field changes it', () => {
  assert.notEqual(
    fingerprint({ Front: 'The valve' }),
    fingerprint({ Front: 'The left AV valve' }),
    'an edited card must fall out of the cache and be looked at again',
  )
})

test('a one-character edit changes it', () => {
  assert.notEqual(fingerprint({ Front: 'aorta' }), fingerprint({ Front: 'aortb' }))
})

test('moving text between fields changes it', () => {
  // `Front: "a b", Back: ""` and `Front: "a", Back: "b"` are different prompts,
  // and a naive concatenation would call them identical.
  assert.notEqual(
    fingerprint({ Front: 'a b', Back: '' }),
    fingerprint({ Front: 'a', Back: 'b' }),
  )
})

test('an added empty field changes it', () => {
  assert.notEqual(fingerprint({ Front: 'a' }), fingerprint({ Front: 'a', Extra: '' }))
})

test('it is a short hex string', () => {
  assert.match(fingerprint({ Front: 'a' }), /^[0-9a-f]{8,20}$/)
})
