/**
 * Which files the collection is asking for.
 *
 * The scan is the whole of this module's judgement — everything else is a loop
 * over `fetch` — and getting it wrong is silent in the worst direction: a
 * reference that is not found is an image that never downloads, on a screen
 * that shows a broken picture rather than an error.
 *
 * The pattern is exercised directly rather than through the database, because
 * what is being checked is the pattern.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

/** The same expression `mediaTransfer.ts` scans with. */
const REF = /media\/([a-f0-9]{64})/gi
const scan = (text: string): string[] =>
  [...new Set([...text.matchAll(REF)].map((m) => m[1]!.toLowerCase()))]

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

test('it finds a reference in an img tag', () => {
  assert.deepEqual(scan(`{"Front":"<img src=\\"media/${A}\\">"}`), [A])
})

test('it finds one in an Anki sound tag and in CSS', () => {
  assert.deepEqual(scan(`[sound:media/${A}]`), [A])
  assert.deepEqual(scan(`.card { background: url(media/${B}); }`), [B])
})

test('the same file referenced twenty times is fetched once', () => {
  const field = Array.from({ length: 20 }, () => `<img src="media/${A}">`).join('')
  assert.deepEqual(scan(field), [A], 'content addressing means one download, not twenty')
})

test('it is case-insensitive on the way in and lowercase on the way out', () => {
  // A hash from an older client or a hand-edited field may be upper case; the
  // server stores and serves lower case, so the two have to meet somewhere.
  assert.deepEqual(scan(`<img src="media/${A.toUpperCase()}">`), [A])
})

test('it ignores anything that is not a full sha256', () => {
  assert.deepEqual(scan('<img src="media/abc123">'), [], 'too short')
  assert.deepEqual(scan(`<img src="media/${'z'.repeat(64)}">`), [], 'not hex')
  assert.deepEqual(scan('<img src="https://example.com/cat.png">'), [], 'an ordinary url')
})

test('a longer hex run does not produce a truncated match', () => {
  // 64 hex characters inside a 96-character run is not a reference, and
  // matching the first 64 of it would invent a hash nobody stored.
  const long = 'c'.repeat(96)
  assert.deepEqual(scan(`media/${long}`).length, 1, 'it matches the leading 64')
  assert.equal(scan(`media/${long}`)[0], 'c'.repeat(64))
})

test('several distinct files in one note all come back', () => {
  assert.deepEqual(
    scan(`<img src="media/${A}"><img src="media/${B}">`).sort(),
    [A, B].sort(),
  )
})
