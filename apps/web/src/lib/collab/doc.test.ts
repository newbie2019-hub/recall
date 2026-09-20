/**
 * The merge rules, checked without a server or a browser.
 *
 * What is tested here is what a wrong answer costs: two people typing in one
 * field and one of them losing a sentence, a note arriving twice because its
 * key was minted twice, or a reconnect replaying an edit that was already
 * applied. Everything below runs two `Y.Doc`s and moves updates between them by
 * hand — which is exactly what `provider.ts` does over the wire, minus the
 * wire.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { applyText, decodeUpdate, encodeUpdate, putNote, readAll, readNote, removeNote } from './doc.ts'

/** Move everything one doc knows into the other, the way the server does. */
function sync(from: Y.Doc, to: Y.Doc) {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)))
}

const note = (id: string, fields: Record<string, string>) => ({
  id,
  noteTypeId: 'basic',
  deckId: 'deck-1',
  fields,
  tags: 'pharm',
})

test('two people typing in one field keep both edits', () => {
  const a = new Y.Doc()
  const b = new Y.Doc()

  putNote(a, note('n1', { Front: 'aorta', Back: '' }))
  sync(a, b)

  // Neither sees the other while they type — the offline half of the phase.
  putNote(a, note('n1', { Front: 'the aorta', Back: '' }))
  putNote(b, note('n1', { Front: 'aorta is an artery', Back: '' }))

  sync(a, b)
  sync(b, a)

  const front = readNote(a, 'n1')!.fields.Front!
  assert.equal(front, readNote(b, 'n1')!.fields.Front, 'the two docs converged')
  // Both edits are in there: a prefix insert and a suffix insert do not collide.
  assert.match(front, /^the /)
  assert.match(front, /artery$/)
})

test('an edit at one end of a field does not delete the other end', () => {
  const a = new Y.Doc()
  const b = new Y.Doc()
  putNote(a, note('n1', { Front: 'one two three four five' }))
  sync(a, b)

  putNote(a, note('n1', { Front: 'ONE two three four five' }))
  putNote(b, note('n1', { Front: 'one two three four FIVE' }))

  sync(a, b)
  sync(b, a)

  const front = readNote(a, 'n1')!.fields.Front
  assert.equal(front, 'ONE two three four FIVE')
})

test('replacing a field wholesale is what a naive implementation would do — and loses one', () => {
  // The control for the test above. Delete-everything-then-insert is a valid
  // Y.Text edit; it is just the one that throws away a collaborator's work.
  const a = new Y.Doc()
  const b = new Y.Doc()
  putNote(a, note('n1', { Front: 'one two three' }))
  sync(a, b)

  for (const [doc, value] of [[a, 'ONE two three'], [b, 'one two THREE']] as const) {
    const text = (doc.getMap('notes').get('n1') as Y.Map<unknown>).get('fields') as Y.Map<Y.Text>
    const field = text.get('Front')!
    doc.transact(() => {
      field.delete(0, field.length)
      field.insert(0, value)
    })
  }

  sync(a, b)
  sync(b, a)

  // Whatever survives, it is not both. This is the failure `applyText` exists
  // to avoid, asserted so the reason stays visible.
  const front = readNote(a, 'n1')!.fields.Front
  assert.ok(front !== 'ONE two THREE', 'a full replace cannot merge both edits')
})

test('adding different notes at once keeps both', () => {
  const a = new Y.Doc()
  const b = new Y.Doc()
  putNote(a, note('n1', { Front: 'first' }))
  sync(a, b)

  putNote(a, note('n2', { Front: 'mine' }))
  putNote(b, note('n3', { Front: 'yours' }))

  sync(a, b)
  sync(b, a)

  assert.deepEqual(readAll(a).map((n) => n.id).sort(), ['n1', 'n2', 'n3'])
  assert.deepEqual(readAll(b).map((n) => n.id).sort(), ['n1', 'n2', 'n3'])
})

test('a deletion travels, and re-applying an update is a no-op', () => {
  const a = new Y.Doc()
  const b = new Y.Doc()
  putNote(a, note('n1', { Front: 'gone soon' }))
  sync(a, b)

  const update = Y.encodeStateAsUpdate(a)
  removeNote(a, 'n1')
  sync(a, b)
  assert.equal(readNote(b, 'n1'), null)

  // The reconnect case: the same bytes arriving twice must not resurrect it.
  Y.applyUpdate(b, update)
  assert.equal(readNote(b, 'n1'), null)
})

test('a late joiner converges on the same document', () => {
  const a = new Y.Doc()
  const b = new Y.Doc()
  const late = new Y.Doc()

  putNote(a, note('n1', { Front: 'aorta' }))
  sync(a, b)
  putNote(b, note('n1', { Front: 'aorta, largest artery' }))
  putNote(a, note('n2', { Front: 'vena cava' }))
  sync(a, b)
  sync(b, a)

  // Joins mid-session and takes the whole state, as `fetchDocState` hands it
  // over on a first open.
  Y.applyUpdate(late, Y.encodeStateAsUpdate(a))

  assert.deepEqual(readAll(late).map((n) => n.id).sort(), ['n1', 'n2'])
  assert.equal(readNote(late, 'n1')!.fields.Front, readNote(a, 'n1')!.fields.Front)
})

test('merged updates are equivalent to the updates they replace', () => {
  // What `flush()` relies on: a minute of offline typing goes out as one
  // request, and the result has to be indistinguishable from sending each.
  const a = new Y.Doc()
  const updates: Uint8Array[] = []
  a.on('update', (u: Uint8Array) => updates.push(u))

  putNote(a, note('n1', { Front: 'one' }))
  putNote(a, note('n1', { Front: 'one two' }))
  putNote(a, note('n2', { Front: 'second note' }))

  const oneByOne = new Y.Doc()
  for (const u of updates) Y.applyUpdate(oneByOne, u)

  const merged = new Y.Doc()
  Y.applyUpdate(merged, Y.mergeUpdates(updates))

  assert.deepEqual(readAll(merged), readAll(oneByOne))
})

test('applyText makes the smallest splice, not a replacement', () => {
  const doc = new Y.Doc()
  const text = doc.getText('t')
  text.insert(0, 'the quick brown fox')

  applyText(text, 'the quick red fox')
  assert.equal(text.toString(), 'the quick red fox')

  applyText(text, 'the quick red fox')
  assert.equal(text.toString(), 'the quick red fox', 'an identical value writes nothing')

  applyText(text, '')
  assert.equal(text.toString(), '')

  applyText(text, 'from empty')
  assert.equal(text.toString(), 'from empty')
})

test('base64 round-trips an update byte for byte', () => {
  const doc = new Y.Doc()
  putNote(doc, note('n1', { Front: 'aorta ünïcode 🫀', Back: '<b>html</b>' }))
  const update = Y.encodeStateAsUpdate(doc)

  const decoded = decodeUpdate(encodeUpdate(update))
  assert.deepEqual([...decoded], [...update])

  const other = new Y.Doc()
  Y.applyUpdate(other, decoded)
  assert.equal(readNote(other, 'n1')!.fields.Front, 'aorta ünïcode 🫀')
})

test('scheduling is never in the document', () => {
  const doc = new Y.Doc()
  putNote(doc, note('n1', { Front: 'aorta' }))

  // A card's state is derived from the reviewer's own log (README rule 1).
  // Sharing a deck shares the cards, never what anybody has done with them.
  const keys = [...(doc.getMap('notes').get('n1') as Y.Map<unknown>).keys()].sort()
  assert.deepEqual(keys, ['deck_id', 'fields', 'note_type_id', 'tags'])
})
