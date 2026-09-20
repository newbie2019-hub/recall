import * as Y from 'yjs'

/**
 * The shape of a deck's collaborative document, and the two translations
 * between it and the collection.
 *
 * **One Y.Doc per deck** (PHASES §9). Inside it, `notes` is a `Y.Map` keyed by
 * note id, each note a `Y.Map` of its own whose *fields* are `Y.Text`. That
 * nesting is the whole design:
 *
 * - A `Y.Text` merges two people typing in one field, character by character.
 *   A plain string would merge them by discarding one of them.
 * - A `Y.Map` per note means adding a note and editing a different note are
 *   concurrent operations that never see each other.
 * - Anything that is *not* co-edited — the deck's name, its options, every
 *   card's scheduling — is deliberately absent. Scheduling is per-person and
 *   derived from that person's own review log (README rule 1); putting it in a
 *   shared document would make two people's study history one history.
 *
 * Nothing here talks to the network or to SQLite. `provider.ts` moves updates,
 * `materialize.ts` moves the result into the collection, and keeping the three
 * apart is what makes the merge rules testable without either.
 */

export interface CollabNote {
  id: string
  noteTypeId: string
  deckId: string
  fields: Record<string, string>
  tags: string
}

export const notesMap = (doc: Y.Doc): Y.Map<Y.Map<unknown>> =>
  doc.getMap<Y.Map<unknown>>('notes')

/** The `Y.Text` for one field, created on first use. */
function fieldText(note: Y.Map<unknown>, name: string): Y.Text {
  let text = note.get(name) as Y.Text | undefined
  if (!(text instanceof Y.Text)) {
    text = new Y.Text()
    note.set(name, text)
  }
  return text
}

/**
 * Put a note into the document, or bring an existing one in line with it.
 *
 * Existing fields are *edited*, never replaced. Replacing a `Y.Text` wholesale
 * — the obvious implementation — deletes the shared type everyone else's cursor
 * and pending edits are anchored to, so two people saving at once would take
 * turns destroying each other's paragraph. `applyText` below is why this file
 * carries a diff at all.
 */
export function putNote(doc: Y.Doc, note: CollabNote): void {
  const notes = notesMap(doc)

  doc.transact(() => {
    let entry = notes.get(note.id)
    if (!entry) {
      entry = new Y.Map()
      notes.set(note.id, entry)
    }

    entry.set('note_type_id', note.noteTypeId)
    entry.set('deck_id', note.deckId)
    entry.set('tags', note.tags)

    const fields = (entry.get('fields') as Y.Map<Y.Text> | undefined) ?? new Y.Map<Y.Text>()
    if (!entry.get('fields')) entry.set('fields', fields)

    for (const [name, value] of Object.entries(note.fields)) {
      applyText(fieldText(fields as unknown as Y.Map<unknown>, name), value)
    }
  })
}

/** Remove a note from the shared document. */
export function removeNote(doc: Y.Doc, noteId: string): void {
  const notes = notesMap(doc)
  if (notes.has(noteId)) notes.delete(noteId)
}

/** Read one note back out, or null if the document has never held it. */
export function readNote(doc: Y.Doc, noteId: string): CollabNote | null {
  const entry = notesMap(doc).get(noteId)
  return entry ? toNote(noteId, entry) : null
}

export function readAll(doc: Y.Doc): CollabNote[] {
  const out: CollabNote[] = []
  notesMap(doc).forEach((entry, id) => out.push(toNote(id, entry)))
  return out
}

function toNote(id: string, entry: Y.Map<unknown>): CollabNote {
  const fields: Record<string, string> = {}
  const map = entry.get('fields') as Y.Map<Y.Text> | undefined
  map?.forEach((text, name) => {
    fields[name] = text instanceof Y.Text ? text.toString() : String(text ?? '')
  })

  return {
    id,
    noteTypeId: String(entry.get('note_type_id') ?? ''),
    deckId: String(entry.get('deck_id') ?? ''),
    fields,
    tags: String(entry.get('tags') ?? ''),
  }
}

/**
 * Edit a `Y.Text` into a new value with the smallest splice that gets there.
 *
 * The fields in this app are `contentEditable` HTML, so what arrives from the
 * editor is the whole field, not a keystroke. Turning that back into an *edit*
 * is what makes concurrent typing merge: a common prefix and suffix scan finds
 * the one region that actually changed, so two people working at opposite ends
 * of a paragraph produce two non-overlapping operations and both survive.
 *
 * Delete-then-insert on the whole string would also "work", and would lose one
 * of the two edits every time.
 *
 * ponytail: prefix/suffix only, so a change in two places at once collapses
 * into one splice spanning both — still correct, merely coarser, and a real
 * character diff (`packages/core/src/diff.ts` has an LCS) is the upgrade if a
 * measurement ever says it matters.
 */
export function applyText(text: Y.Text, next: string): void {
  const current = text.toString()
  if (current === next) return

  let start = 0
  const max = Math.min(current.length, next.length)
  while (start < max && current[start] === next[start]) start++

  let end = 0
  while (
    end < max - start &&
    current[current.length - 1 - end] === next[next.length - 1 - end]
  ) {
    end++
  }

  const removed = current.length - start - end
  const inserted = next.slice(start, next.length - end)

  if (removed > 0) text.delete(start, removed)
  if (inserted) text.insert(start, inserted)
}

/** Base64 for the wire, because updates travel as JSON. */
export const encodeUpdate = (update: Uint8Array): string => {
  let binary = ''
  for (const byte of update) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export const decodeUpdate = (payload: string): Uint8Array => {
  const binary = atob(payload)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
