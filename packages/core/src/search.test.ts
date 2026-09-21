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
  // `prop:` used to stand here as an example of an unknown prefix. It is a
  // real one now, so the case needs a prefix that is still unknown — and the
  // invalid *value* cases above are the ones that actually carry the point.
  assert.deepEqual(parseSearch('dupe:1'), [{ kind: 'text', value: 'dupe:1', neg: false }])
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

// ── prop: added: rated: nid: re: ───────────────────────────────────────────
//
// Anki's spellings, so a search somebody has written down still works. Each one
// is a new `TermKind` and nothing else — which is what keeps `formatSearch`
// able to round-trip the box back into facet chips, the reason this file has no
// OR and no parentheses.

const NOW = 1_700_000_000_000

test('every new prefix round-trips through formatSearch', () => {
  // If this breaks, the filter bar and the text box stop being one state and
  // clicking a chip silently drops part of the query.
  const input = 'prop:ivl>21 added:30 rated:7:1 nid:abc re:^mitral -prop:lapses>=3'
  assert.equal(formatSearch(parseSearch(input)), input)
})

test('an unknown property falls back to text rather than matching everything', () => {
  // `prop:eas>2` is a real thing to type — ease is Anki's, not ours.
  const [t] = parseSearch('prop:eas>2')
  assert.equal(t!.kind, 'text')
  assert.equal(t!.value, 'prop:eas>2')
})

test('a malformed comparison is text too', () => {
  assert.equal(parseSearch('prop:ivl21')[0]!.kind, 'text')
  assert.equal(parseSearch('prop:ivl>>2')[0]!.kind, 'text')
})

test('prop compares the column for the properties that are columns', () => {
  assert.match(searchSql(parseSearch('prop:reps>10')).sql, /c\.reps > \?/)
  assert.deepEqual(searchSql(parseSearch('prop:lapses>=3')).params, [3])
  assert.match(searchSql(parseSearch('prop:s<21')).sql, /c\.stability < \?/)
})

test('prop:ivl and prop:due are days, not the milliseconds stored', () => {
  assert.match(searchSql(parseSearch('prop:ivl>21'), NOW).sql, /86400000\.0 > \?/)
  // And due excludes new cards, like `due:` does — they have no date worth one.
  assert.match(searchSql(parseSearch('prop:due<0'), NOW).sql, /c\.state != 'new'/)
})

test('prop:r flips the operator, because recall falls as time passes', () => {
  // The bug this guards is returning exactly the cards you did not ask for.
  // "Recall above 90%" is "seen recently", so the elapsed-time test is `<=`.
  assert.match(searchSql(parseSearch('prop:r>=0.9'), NOW).sql, /<=/)
  assert.match(searchSql(parseSearch('prop:r<0.9'), NOW).sql, />/)
})

test('prop:r needs no POWER, because the threshold is inverted in advance', () => {
  // sqlite-wasm is not promised the maths functions, so the compiled SQL must
  // contain arithmetic and nothing else.
  const { sql } = searchSql(parseSearch('prop:r>0.8'), NOW)
  assert.doesNotMatch(sql, /POWER|EXP|LN|POW/i)
  assert.match(sql, /c\.stability/)
})

test('prop:r=0.9 means "shows 90%", since a float is never equal to anything', () => {
  const { sql } = searchSql(parseSearch('prop:r=0.9'), NOW)
  assert.match(sql, />=/)
  assert.match(sql, /<=/)
})

test('a recall threshold outside 0-1 is a constant, not an impossible comparison', () => {
  assert.equal(searchSql(parseSearch('prop:r>1.5'), NOW).sql, '0')
  assert.equal(searchSql(parseSearch('prop:r<1.5'), NOW).sql, '1')
})

test('added: asks the card, because a second template adds a card of its own', () => {
  const { sql, params } = searchSql(parseSearch('added:30'), NOW)
  assert.match(sql, /c\.created_at >= \?/)
  assert.deepEqual(params, [NOW - 30 * 86_400_000])
})

test('rated: asks the log, and rated:n:1 asks only about failures', () => {
  const plain = searchSql(parseSearch('rated:7'), NOW)
  assert.match(plain.sql, /EXISTS \(SELECT 1 FROM reviews/)
  assert.deepEqual(plain.params, [NOW - 7 * 86_400_000])

  const failed = searchSql(parseSearch('rated:7:1'), NOW)
  assert.match(failed.sql, /rv\.rating = \?/)
  assert.deepEqual(failed.params, [NOW - 7 * 86_400_000, 1])
})

test('a regex is compiled at parse time, so a broken one is text', () => {
  assert.equal(parseSearch('re:^mitral')[0]!.kind, 're')
  assert.equal(parseSearch('re:[unclosed')[0]!.kind, 'text')
})

test('the regex pattern is bound, never interpolated', () => {
  const { sql, params } = searchSql(parseSearch('re:^a.*z$'))
  assert.equal(sql, 'n.fields REGEXP ?')
  assert.deepEqual(params, ['^a.*z$'])
})

test('negation still wraps the new kinds rather than inverting them', () => {
  assert.equal(searchSql(parseSearch('-added:7'), NOW).sql, 'NOT (c.created_at >= ?)')
})
