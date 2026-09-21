/**
 * Channel refcounting.
 *
 * Two features want the same presence channel — co-editing and Together mode —
 * and Echo hands both of them the same cached object. The bug this guards is
 * one of them closing and silently unsubscribing the other's live session,
 * which would look like a room that simply stopped updating.
 *
 *   node --experimental-strip-types --test src/lib/collab/echo.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { releaseChannel, retainChannel } from './echo.ts'

test('the channel is left by the last holder, not the first to let go', () => {
  retainChannel('deck.d1')   // co-editing
  retainChannel('deck.d1')   // a study session on the same deck

  assert.equal(releaseChannel('deck.d1'), false, 'the editor closing must not leave')
  assert.equal(releaseChannel('deck.d1'), true, 'the last one out leaves')
})

test('a stray release does not re-arm the leave', () => {
  // Counting down past zero would make the *next* retain/release pair leave a
  // channel somebody else had just joined.
  retainChannel('deck.d2')
  assert.equal(releaseChannel('deck.d2'), true)
  assert.equal(releaseChannel('deck.d2'), true, 'unheld is already left')

  retainChannel('deck.d2')
  retainChannel('deck.d2')
  assert.equal(releaseChannel('deck.d2'), false, 'the count restarted cleanly')
})

test('decks are counted separately', () => {
  retainChannel('deck.a')
  retainChannel('deck.a')
  retainChannel('deck.b')

  assert.equal(releaseChannel('deck.b'), true, 'b had one holder')
  assert.equal(releaseChannel('deck.a'), false, 'and a still has two')
})
