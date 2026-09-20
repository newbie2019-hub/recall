import type * as Y from 'yjs'
import * as repo from '@/db/repo'
import { db } from '@/db/client'
import { putNote, readAll, removeNote, type CollabNote } from './doc.ts'

/**
 * The bridge between the shared document and the collection.
 *
 * PHASES §9: *"Materialize applied updates into local SQLite so study and
 * search keep one source of truth. During a session, never write those rows
 * directly."* Both halves matter, and the second is the one that is easy to
 * break — every other screen in the app writes notes through `repo.saveNote`,
 * and a shared deck has to route through the document instead or two people's
 * edits stop being merged and start overwriting.
 *
 * So there are exactly two directions here:
 *
 * - **In**, once per session: the local rows seed the document for a deck that
 *   has never been shared before. After that the document is authoritative and
 *   this is not called again.
 * - **Out**, on every change: notes the document holds are written into
 *   `notes`, so the study loop, the browser and search keep working on ordinary
 *   SQL and know nothing about CRDTs.
 *
 * Scheduling is never materialized in either direction, because it is not in
 * the document: a card's state is derived from *this* person's review log
 * (README rule 1), and sharing a deck must not share a schedule.
 */

/**
 * Seed a document from the collection, once.
 *
 * Guarded on the document already being empty rather than on a flag: the check
 * is cheap, and it is the only version that stays correct when two people open
 * a never-shared deck at the same moment. The loser's seed finds a populated
 * document and does nothing, instead of writing every note a second time.
 */
export async function seedFromCollection(doc: Y.Doc, deckId: string): Promise<number> {
  if (doc.getMap('notes').size > 0) return 0

  const notes = await localNotes(deckId)
  if (!notes.length) return 0

  doc.transact(() => {
    for (const note of notes) putNote(doc, note)
  })

  return notes.length
}

/**
 * Write the document's notes into the collection.
 *
 * `repo.saveNote` rather than raw SQL, so a note arriving from a collaborator
 * goes through the same card generation, duplicate checksum and tag handling as
 * one typed here. A remote edit that emptied a field has to withdraw its card
 * exactly like a local one, and that rule lives in `regenerateCards`.
 *
 * Returns how many rows actually moved, which is what the editor uses to avoid
 * repainting on a no-op.
 */
export async function materialize(doc: Y.Doc, deckId: string): Promise<number> {
  const incoming = readAll(doc)
  if (!incoming.length) return 0

  const existing = new Map((await localNotes(deckId)).map((n) => [n.id, n]))
  let written = 0

  for (const note of incoming) {
    const current = existing.get(note.id)
    if (current && sameNote(current, note)) continue

    await repo.saveNote({
      id: note.id,
      noteTypeId: note.noteTypeId,
      deckId: note.deckId || deckId,
      fields: note.fields,
      tags: note.tags.split(' ').filter(Boolean),
    })
    written++
  }

  return written
}

/**
 * Push one locally-edited note into the document.
 *
 * This is what the note editor calls instead of `repo.saveNote` while a deck is
 * shared. The write comes back around through `materialize`, so the row is
 * still written by the same code path as everything else — it just goes via the
 * document, which is what makes it merge with whatever somebody else is typing.
 */
export function publishNote(doc: Y.Doc, note: CollabNote): void {
  putNote(doc, note)
}

/** Deleting a note locally removes it for everybody, which is what sharing means. */
export function publishDeletion(doc: Y.Doc, noteId: string): void {
  removeNote(doc, noteId)
}

/** The deck's notes as the collection holds them, in the document's shape. */
async function localNotes(deckId: string): Promise<CollabNote[]> {
  const rows = await db.select<{
    id: string
    note_type: string
    deck_id: string
    fields: string
    tags: string
  }>(
    `WITH RECURSIVE sub(id) AS (
       SELECT ? UNION ALL SELECT d.id FROM decks d JOIN sub ON d.parent_id = sub.id
     )
     SELECT id, note_type, deck_id, fields, tags
       FROM notes WHERE deck_id IN (SELECT id FROM sub) ORDER BY rowid`,
    [deckId],
  )

  return rows.map((r) => ({
    id: r.id,
    noteTypeId: r.note_type,
    deckId: r.deck_id,
    fields: JSON.parse(r.fields) as Record<string, string>,
    tags: String(r.tags ?? ''),
  }))
}

/**
 * Whether a materialize would be a no-op.
 *
 * Field-by-field rather than `JSON.stringify` on both: key order in a decoded
 * `Y.Map` is insertion order, which is not the order the local JSON column was
 * written in, and comparing the serialisations would report every note as
 * changed on every update.
 */
function sameNote(a: CollabNote, b: CollabNote): boolean {
  if (a.noteTypeId !== b.noteTypeId || a.tags !== b.tags) return false

  const keys = new Set([...Object.keys(a.fields), ...Object.keys(b.fields)])
  for (const key of keys) {
    if ((a.fields[key] ?? '') !== (b.fields[key] ?? '')) return false
  }
  return true
}
