/**
 * The queue, which is the half of Phase 9 that a CRDT does not give you free.
 *
 * Yjs guarantees that updates merge whenever they arrive. It does not promise
 * that they arrive — that is this file's job, and PHASES §9's "done when" names
 * it: *one of them on a flaky connection, nothing is lost*. So what is checked
 * here is that a failed send is kept, retried as one merged update, and that a
 * viewer's session never sends anything at all.
 *
 * No websocket: `VITE_REVERB_APP_KEY` is unset under the test runner, so
 * `acquireEcho()` returns null and the session runs with its HTTP half only —
 * which is exactly the "socket is down" case worth testing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { CollabSession } from './provider.ts'
import { putNote, readNote } from './doc.ts'

interface Sent { url: string; body: unknown }

/**
 * A server that can be switched offline.
 *
 * `fetch` is replaced rather than the transport module: the provider's error
 * handling branches on `ApiError('offline')`, which is produced by a thrown
 * fetch, so stubbing any higher would test a different code path than the one
 * a dropped connection takes.
 */
function stubServer() {
  const sent: Sent[] = []
  const state = { online: true, seq: 0, updates: [] as string[] }

  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    if (!state.online) throw new TypeError('Failed to fetch')

    const href = String(url)
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    sent.push({ url: href, body })

    if (href.includes('/doc/updates')) {
      state.seq++
      state.updates.push((body as { payload: string }).payload)
      return json({ seq: state.seq, should_compact: false })
    }

    if (href.includes('/doc/snapshot')) return json({ up_to_seq: state.seq })

    // GET .../doc
    return json({
      snapshot: null,
      snapshot_seq: 0,
      updates: state.updates.map((payload, i) => ({ seq: i + 1, payload })),
      cursor: state.seq,
      should_compact: false,
    })
  }) as typeof globalThis.fetch

  return { sent, state }
}

const json = (data: unknown) =>
  new Response(JSON.stringify({ data, server_time: Date.now() }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

const note = (id: string, Front: string) => ({
  id, noteTypeId: 'basic', deckId: 'deck-1', fields: { Front }, tags: '',
})

test('edits made offline are kept and go out as one update on reconnect', async () => {
  const server = stubServer()
  const session = new CollabSession({ deckId: 'deck-1', canWrite: true })
  await session.start()

  server.state.online = false

  putNote(session.doc, note('n1', 'aorta'))
  putNote(session.doc, note('n1', 'aorta, largest artery'))
  putNote(session.doc, note('n2', 'vena cava'))

  await session.flush()
  assert.ok(session.queued > 0, 'the edits are held, not dropped')

  server.state.online = true
  await session.flush()

  assert.equal(session.queued, 0, 'the queue drained')
  // One request for three edits: `Y.mergeUpdates` is what makes a reconnect
  // after a long offline stretch cost one round trip rather than hundreds.
  const posts = server.sent.filter((s) => s.url.includes('/doc/updates'))
  assert.equal(posts.length, 1)

  // And the merged update carries everything.
  const other = new Y.Doc()
  const payload = (posts[0]!.body as { payload: string }).payload
  Y.applyUpdate(other, Buffer.from(payload, 'base64'))
  assert.equal(readNote(other, 'n1')!.fields.Front, 'aorta, largest artery')
  assert.equal(readNote(other, 'n2')!.fields.Front, 'vena cava')

  session.stop()
})

test('a viewer applies the document and sends nothing', async () => {
  const server = stubServer()
  const session = new CollabSession({ deckId: 'deck-1', canWrite: false })
  await session.start()

  putNote(session.doc, note('n1', 'a viewer types anyway'))
  await session.flush()

  assert.equal(session.queued, 0)
  assert.equal(server.sent.filter((s) => s.url.includes('/doc/updates')).length, 0)

  session.stop()
})

test('a session reports its status, and offline is not an error', async () => {
  const server = stubServer()
  const seen: string[] = []
  const session = new CollabSession({
    deckId: 'deck-1',
    canWrite: true,
    onStatus: (status) => seen.push(status),
  })

  await session.start()
  assert.deepEqual(seen, ['live'])

  server.state.online = false
  putNote(session.doc, note('n1', 'typed into the void'))
  await session.flush()

  assert.equal(seen.at(-1), 'offline')

  server.state.online = true
  await session.flush()
  assert.equal(seen.at(-1), 'live')

  session.stop()
})

test('a demotion mid-session stops the sending and keeps the typing', async () => {
  stubServer()
  const session = new CollabSession({ deckId: 'deck-1', canWrite: true })
  await session.start()

  // The role changed underneath: the server now answers 403 to this person.
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ error: { code: 'forbidden', message: 'You have read-only access.' } }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    )) as typeof globalThis.fetch

  putNote(session.doc, note('n1', 'still mine to type'))
  await session.flush()

  // Their own document keeps the work — it is their writing, and the server
  // refusing it is not a reason to delete it from in front of them.
  assert.equal(readNote(session.doc, 'n1')!.fields.Front, 'still mine to type')
  assert.equal(session.queued, 0, 'a refused update is not retried forever')

  session.stop()
})

test('a first open reads the whole log and applies it in order', async () => {
  const server = stubServer()

  // Somebody else's session filled the log first.
  const theirs = new CollabSession({ deckId: 'deck-1', canWrite: true })
  await theirs.start()
  putNote(theirs.doc, note('n1', 'aorta'))
  await theirs.flush()
  putNote(theirs.doc, note('n2', 'vena cava'))
  await theirs.flush()
  theirs.stop()

  const mine = new CollabSession({ deckId: 'deck-1', canWrite: true })
  await mine.start()

  assert.equal(readNote(mine.doc, 'n1')!.fields.Front, 'aorta')
  assert.equal(readNote(mine.doc, 'n2')!.fields.Front, 'vena cava')
  // Reading the document must not re-post it: applying a server update is
  // marked with the session as its origin precisely so it is not sent back.
  const before = server.sent.filter((s) => s.url.includes('/doc/updates')).length
  await mine.flush()
  assert.equal(server.sent.filter((s) => s.url.includes('/doc/updates')).length, before)

  mine.stop()
})
