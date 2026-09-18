/** Sibling burying: who gets hidden, who is left alone, and until when. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  areSiblings, nextDayStart, noteIdOf, ordOf, siblingsToBury, type SiblingCard,
} from './siblings.ts'

const c = (id: string, over: Partial<SiblingCard> = {}): SiblingCard => ({
  id, state: 'review', suspended: false, buried_until: null, ...over,
})

test('rule 2 makes siblings findable without a lookup', () => {
  assert.equal(noteIdOf('abc-123:2'), 'abc-123')
  assert.equal(ordOf('abc-123:2'), 2)
  assert.ok(areSiblings('abc-123:0', 'abc-123:1'))
  assert.equal(areSiblings('abc-123:0', 'abc-123:0'), false)
  assert.equal(areSiblings('abc-123:0', 'other:0'), false)
  // A malformed id must not silently claim every card as its sibling.
  assert.equal(noteIdOf('nocolon'), 'nocolon')
  assert.equal(ordOf('nocolon'), 0)
})

test('answering one card hides the note\'s others, and nothing else', () => {
  const until = 200
  assert.deepEqual(
    siblingsToBury('n:0', [c('n:0'), c('n:1'), c('n:2'), c('other:0')], until),
    ['n:1', 'n:2'],
  )
})

test('a suspension and a longer bury both survive answering a sibling', () => {
  const until = 200
  const cards = [
    c('n:0'),
    c('n:1', { suspended: true }),        // the user's decision, not ours to shorten
    c('n:2', { buried_until: 999 }),      // already hidden for longer
    c('n:3', { buried_until: 50 }),       // a stale bury is refreshed
  ]
  assert.deepEqual(siblingsToBury('n:0', cards, until), ['n:3'])
})

test('new siblings follow their own deck option', () => {
  const cards = [c('n:0'), c('n:1', { state: 'new' }), c('n:2')]
  assert.deepEqual(siblingsToBury('n:0', cards, 200), ['n:1', 'n:2'])
  assert.deepEqual(siblingsToBury('n:0', cards, 200, { newCards: false }), ['n:2'])
  assert.deepEqual(siblingsToBury('n:0', cards, 200, { reviews: false }), ['n:1'])
})

test('the bury ends at the next local midnight, DST included', () => {
  const noon = new Date(2026, 2, 7, 12, 30).getTime()
  const end = new Date(nextDayStart(noon))
  assert.deepEqual([end.getHours(), end.getMinutes()], [0, 0])
  assert.equal(end.getDate(), 8)

  // US spring-forward: the day is 23h long, so midnight + 86,400,000 would
  // overshoot into the 9th's 01:00 and hold the card an extra hour.
  const dstEve = new Date(2026, 2, 8, 12, 0).getTime()
  const after = new Date(nextDayStart(dstEve))
  assert.deepEqual([after.getDate(), after.getHours()], [9, 0])
})
