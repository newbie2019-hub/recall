/**
 * The parser is the trust boundary: everything downstream interpolates the
 * operator and the state name straight into SQL, so anything that reaches
 * `searchSql` as a typed term must already have been validated here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatSearch, parseSearch, searchSql, setFacet } from './search.ts'

test('prefixes, negation and quoting', () => {
  assert.deepEqual(parseSearch('deck:Anatomy tag:thorax is:due -flag:1 mitral'), [
    { kind: 'deck', value: 'Anatomy', neg: false },
    { kind: 'tag', value: 'thorax', neg: false },
    { kind: 'is', value: 'due', neg: false },
    { kind: 'flag', value: '1', neg: true },
    { kind: 'text', value: 'mitral', neg: false },
  ])
  assert.deepEqual(parseSearch('tag:"needs work"'), [
    { kind: 'tag', value: 'needs work', neg: false },
  ])
  assert.equal(formatSearch(parseSearch('tag:"needs work" -is:suspended x')), 'tag:"needs work" -is:suspended x')
})

test('an invalid value degrades to text, never to a dropped filter', () => {
  // The dangerous failure is the opposite: dropping `is:dur` would silently
  // widen the selection a bulk operation is about to act on.
  assert.deepEqual(parseSearch('is:dur'), [{ kind: 'text', value: 'is:dur', neg: false }])
  assert.deepEqual(parseSearch('flag:9'), [{ kind: 'text', value: 'flag:9', neg: false }])
  assert.deepEqual(parseSearch('lapses:x'), [{ kind: 'text', value: 'lapses:x', neg: false }])
  assert.deepEqual(parseSearch('prop:ivl>3'), [{ kind: 'text', value: 'prop:ivl>3', neg: false }])
})

test('empty search matches everything rather than nothing', () => {
  assert.deepEqual(searchSql([]), { sql: '1', params: [] })
})

test('values are bound, operators are not user input', () => {
  const { sql, params } = searchSql(parseSearch("lapses:>=3 flag:2 is:review tag:a'b"), 1000)
  assert.match(sql, /c\.lapses >= \?/)
  assert.match(sql, /c\.state = \?/)
  assert.deepEqual(params, [3, 2, 'review', "% a'b %", "% a'b::%"])
})

test('a tag matches its children — a sidebar folder is not a leaf', () => {
  const { sql, params } = searchSql(parseSearch('tag:anatomy'))
  assert.match(sql, /LIKE \? ESCAPE/)
  assert.deepEqual(params, ['% anatomy %', '% anatomy::%'])
})

test('LIKE metacharacters in a tag are escaped, not matched', () => {
  assert.deepEqual(searchSql(parseSearch('tag:50%_off')).params, ['% 50\\%\\_off %', '% 50\\%\\_off::%'])
})

test('negation wraps, it does not invert the operator', () => {
  const { sql } = searchSql(parseSearch('-is:suspended'))
  assert.equal(sql, 'NOT (c.suspended = 1)')
})

test('due windows are absolute timestamps, and new cards are excluded', () => {
  const now = 1_700_000_000_000
  const { sql, params } = searchSql(parseSearch('due:7'), now)
  assert.match(sql, /c\.state != 'new'/)
  assert.deepEqual(params, [now + 7 * 86_400_000])
})

test('marked and leech are reserved tags, not card columns', () => {
  assert.deepEqual(searchSql(parseSearch('is:marked')).params, ['% marked %', '% marked::%'])
})

test('setFacet replaces rather than accumulates', () => {
  const terms = setFacet(setFacet(parseSearch('tag:x'), 'is', 'new'), 'is', 'review')
  assert.equal(formatSearch(terms), 'tag:x is:review')
  assert.equal(formatSearch(setFacet(terms, 'is', null)), 'tag:x')
})
