/**
 * The room's arithmetic, which is the half of Together mode that nothing else
 * checks.
 *
 * Reverb decides who may whisper; this file decides what the numbers mean once
 * the whispers land, and every case in it is one of the seven the plan wrote
 * down before the code existed: a second tab that would double you, a tab that
 * died without saying goodbye, and a member who has finished the deck and must
 * not be labelled idle for it.
 *
 * No websocket and no browser: a `send` in the options is the whole transport,
 * so `subscribe()` never reaches `echo.ts` and beats arrive by being handed to
 * `receive()` the way the whisper listener hands them over.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StudySession, type SessionBeat } from './session.ts'

const T0 = 1_700_000_000_000

const beat = (id: string, answered: number, since: number, state: SessionBeat['state'] = 'studying'): SessionBeat => ({
  id, name: id.toUpperCase(), answered, since, state,
})

/** A session with a fake transport and a clock the test winds forward. */
function makeSession(sent: SessionBeat[] = []) {
  const clock = { t: T0 }
  const session = new StudySession({
    deckId: 'deck-1',
    me: { id: 'me', name: 'Me' },
    send: (b) => void sent.push(b),
    now: () => clock.t,
  })
  return Object.assign(session, { clock })
}

test('beats merge into one entry per person, in join order', () => {
  const session = makeSession()

  // Deliberately out of order, and with the latest joiner beating first.
  session.receive(beat('c', 1, T0 + 200))
  session.receive(beat('a', 2, T0))
  session.receive(beat('b', 3, T0 + 100))
  session.receive(beat('a', 5, T0))

  const roster = session.roster()
  assert.deepEqual(roster.map((m) => m.id), ['a', 'b', 'c'], 'arrival order, never score order')
  assert.equal(roster.length, 3, 'a second beat updates an entry rather than adding one')
  assert.equal(roster[0]!.answered, 5)
})

test('two beats from one person do not double the total', () => {
  const session = makeSession()

  // The same user on two tabs: presence lists a member per connection, so both
  // of these are genuinely "them", and adding them would flatter the room.
  session.receive(beat('a', 7, T0))
  session.receive(beat('a', 2, T0 + 5_000))

  assert.equal(session.roster().length, 1)
  assert.equal(session.total(), 7, 'the highest count wins, and the total is a lower bound')
  assert.equal(session.roster()[0]!.since, T0, 'the earlier arrival keeps the row in place')
})

test('the total is the sum of the deduped members', () => {
  const session = makeSession()

  session.receive(beat('a', 4, T0))
  session.receive(beat('b', 6, T0 + 1))
  session.receive(beat('a', 4, T0)) // a heartbeat, not a new person

  assert.equal(session.total(), 10)
})

test('a member who stops beating drops out of the room', () => {
  const session = makeSession()

  session.receive(beat('a', 4, T0))
  session.receive(beat('b', 6, T0 + 1))

  session.clock.t = T0 + 29_000
  assert.equal(session.total(), 10, 'a pause is not a departure')

  // `a` keeps beating the same number; `b`'s tab has died without saying so.
  session.receive(beat('a', 4, T0))

  session.clock.t = T0 + 31_000
  assert.deepEqual(session.roster().map((m) => m.id), ['a'], 'only the silent one is dropped')
  assert.equal(session.total(), 4)
})

test('identity comes from the server, not from the payload', () => {
  const session = makeSession()

  // Reverb stamps the authenticated user id on every rebroadcast client event,
  // so a beat claiming to be somebody else is filed under whoever sent it.
  session.receive(beat('a', 3, T0), 'b')
  session.receive(beat('a', 4, T0 + 1), 'b')

  assert.deepEqual(session.roster().map((m) => m.id), ['b'])
  assert.equal(session.total(), 4)
})

test('nothing due reads as caught up, and silence reads as idle', () => {
  const session = makeSession()

  session.receive(beat('a', 12, T0, 'caught-up'))
  session.receive(beat('b', 3, T0 + 1))

  assert.equal(session.roster()[0]!.state, 'caught-up')
  assert.equal(session.roster()[1]!.state, 'studying')

  // Two minutes on, both still beating the same numbers — so neither has
  // expired, and only the one who never said they had finished turns idle.
  session.clock.t = T0 + 121_000
  session.receive(beat('a', 12, T0, 'caught-up'))
  session.receive(beat('b', 3, T0 + 1))

  assert.equal(session.roster()[0]!.state, 'caught-up')
  assert.equal(session.roster()[1]!.state, 'idle')
})

test('a rubbish beat is dropped rather than counted', () => {
  const session = makeSession()

  session.receive(null)
  session.receive({ id: 'a' })
  session.receive({ id: '', answered: 1, since: T0 })
  session.receive({ id: 'a', answered: 'lots', since: T0 })
  session.receive({ id: 'a', answered: Number.NaN, since: T0 })

  assert.deepEqual(session.roster(), [])
})

test('this person counts themselves, and every answer goes out once', () => {
  const sent: SessionBeat[] = []
  const session = makeSession(sent)

  session.start()
  session.receive(beat('a', 2, T0))

  session.answered()
  session.answered()
  session.flush()

  const me = session.roster().find((m) => m.id === 'me')
  assert.equal(me?.answered, 2, 'a whisper is not echoed back, so the count is kept locally')
  assert.equal(session.total(), 4, 'me plus them')

  // Two answers in quick succession are one beat on the wire, the way
  // provider.ts coalesces keystrokes into one request.
  assert.equal(sent.at(-1)?.answered, 2)
  assert.ok(sent.length <= 2, `one beat on start, one for the pair — got ${sent.length}`)

  session.stop()
})

test('a heartbeat that changes nothing does not repaint the strip', () => {
  const repaints: number[] = []
  const session = new StudySession({
    deckId: 'deck-1',
    me: { id: 'me', name: 'Me' },
    send: () => {},
    onChange: (_members, total) => void repaints.push(total),
  })

  session.receive(beat('a', 3, T0))
  session.receive(beat('a', 3, T0))
  session.receive(beat('a', 3, T0))

  assert.deepEqual(repaints, [3], 'nothing may move while a card is on screen')

  session.receive(beat('a', 4, T0))
  assert.deepEqual(repaints, [3, 4], 'an answer is the one thing that does move it')
})

test('a session stops cleanly without a socket', () => {
  const session = makeSession()
  session.start()
  session.stop()
  // Nothing to assert beyond this returning: `stop()` must not reach for a
  // channel it never opened, or leaving a solo room would throw on every exit.
})
