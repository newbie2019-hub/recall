/**
 * The wizard's gate: which answers let you move on.
 *
 * The rule worth testing is the conditional one. "Other" is the only choice
 * that makes a *second* field required, and getting it wrong in either
 * direction is a real bug: too strict and nobody can leave step two, too loose
 * and the marketing table fills with rows whose subject is the literal string
 * "other" and whose explanation was never asked for.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countryName, stepComplete, STEPS } from './onboarding.ts'

test('a step with nothing answered is not complete', () => {
  assert.equal(stepComplete('role', {}), false)
  assert.equal(stepComplete('subject', {}), false)
  assert.equal(stepComplete('goals', { goals: [] }), false)
  assert.equal(stepComplete('source', {}), false)
})

test('the optional fields really are optional', () => {
  assert.equal(stepComplete('role', { role: 'student' }), true, 'country is not required')
  // The whole time step is optional — minutes and exam date both.
  assert.equal(stepComplete('time', {}), true)
  assert.equal(stepComplete('source', { heard_from: 'reddit' }), true, 'no referral code needed')
})

test('an empty multi-select does not count as an answer', () => {
  assert.equal(stepComplete('goals', { goals: [] }), false)
  assert.equal(stepComplete('goals', { goals: ['career'] }), true)
})

test('choosing "other" makes its free text required, and only then', () => {
  assert.equal(stepComplete('source', { heard_from: 'other' }), false)
  assert.equal(stepComplete('source', { heard_from: 'other', heard_from_other: '   ' }), false,
    'whitespace is not an answer')
  assert.equal(stepComplete('source', { heard_from: 'other', heard_from_other: 'a poster' }), true)

  // The same box left filled after changing back to a real choice must not
  // block anything — the server drops it, and the wizard must not insist on it.
  assert.equal(stepComplete('source', { heard_from: 'reddit', heard_from_other: 'stale' }), true)
})

test('the same rule holds for the subject step', () => {
  assert.equal(stepComplete('subject', { subject: 'other' }), false)
  assert.equal(stepComplete('subject', { subject: 'other', subject_other: 'falconry' }), true)
})

test('an unknown step is never complete', () => {
  // @ts-expect-error — the guard exists for a bad URL, which types cannot stop.
  assert.equal(stepComplete('nonsense', { role: 'student' }), false)
})

test('the steps are ordered, one question each', () => {
  assert.deepEqual(STEPS.map((s) => s.id), ['role', 'subject', 'level', 'goals', 'time', 'source'])
  // Every step but the optional one insists on an answer.
  for (const step of STEPS) {
    if (step.id !== 'time') assert.ok(step.required.length > 0, `${step.id} asks nothing`)
  }
})

test('a country code becomes a name, and a malformed one stays itself', () => {
  assert.equal(countryName('AU'), 'Australia')
  // `Intl.DisplayNames` throws a RangeError on anything that is not a
  // well-formed region, which a stored code from an older build could be.
  assert.equal(countryName('99'), '99')
})
