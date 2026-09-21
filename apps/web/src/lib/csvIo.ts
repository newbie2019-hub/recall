/**
 * CSV rows ⇄ the collection.
 *
 * The parsing and the mapping are pure and live in `@recall/core`; this is the
 * half that touches the database, kept separate so the part with all the edge
 * cases stays testable without one.
 */
import { splitDeckPath, toNotes, type CsvMapping } from '@recall/core'
import { db } from '@/db/client'
import * as repo from '@/db/repo'

/**
 * Write the mapped rows as notes.
 *
 * Through `saveNote`, one row at a time, rather than `importNotes`: these notes
 * have no guid of their own and no history to replay, and `saveNote` is what
 * generates their cards from the note type's templates. A spreadsheet is
 * hundreds of rows, not the twenty thousand an `.apkg` can be, so the round
 * trips are affordable.
 *
 * A row naming a deck that does not exist creates it, because the alternative
 * is failing an import over a deck the file was perfectly clear about.
 */
export async function importCsvNotes(
  rows: string[][],
  mapping: CsvMapping,
  noteTypeId: string,
  defaultDeckId: string,
): Promise<number> {
  const notes = toNotes(rows, mapping)
  if (!notes.length) return 0

  const byPath = new Map(
    [...(await repo.deckPaths())].map(([id, path]) => [path.toLowerCase(), id]),
  )

  let written = 0
  for (const note of notes) {
    const deckId = (note.deck && await ensureDeckPath(note.deck, byPath)) || defaultDeckId
    await repo.saveNote({ noteTypeId, deckId, fields: note.fields, tags: note.tags })
    written++
  }
  return written
}

/**
 * `Anatomy::Thorax::Heart`, creating whatever part of it is missing.
 *
 * Walks down rather than creating the leaf directly, because a deck is a
 * `parent_id` tree: making "Heart" with no "Thorax" above it would put it at
 * the top level under a name that claims otherwise. The cache is updated as it
 * goes, so five hundred rows in one deck cost one lookup.
 */
async function ensureDeckPath(path: string, cache: Map<string, string>): Promise<string | null> {
  let parent: string | null = null
  let walked = ''

  for (const part of splitDeckPath(path)) {
    walked = walked ? `${walked}::${part}` : part
    const known = cache.get(walked.toLowerCase())
    if (known) {
      parent = known
      continue
    }
    parent = await repo.createDeck(part, parent)
    cache.set(walked.toLowerCase(), parent)
  }

  // A path of nothing but separators walks nowhere and returns null, so the
  // caller falls back to the chosen deck rather than making one called "".
  return parent
}

/**
 * Every note in a deck subtree as rows, header first.
 *
 * Fields are exported as their stored HTML, not stripped: this is the app's own
 * backup path as well as an interchange format, and silently flattening
 * `<b>` and `<img>` out of somebody's collection would make the export lossy in
 * a way the file does not admit to. Tags and deck ride along so a round trip
 * lands where it started — the columns `guessMapping` looks for by name.
 *
 * Note types are not mixed: a CSV has one header, so a collection with several
 * note types exports the union of their fields and leaves the rest empty. That
 * is the format's limit, not ours, and `.apkg` is the lossless path.
 */
export async function exportCsv(
  deckId: string | null,
): Promise<{ rows: string[][]; notes: number }> {
  const where = deckId
    ? `WHERE n.deck_id IN (
         WITH RECURSIVE sub(id) AS (
           SELECT ? UNION ALL SELECT d.id FROM decks d JOIN sub ON d.parent_id = sub.id)
         SELECT id FROM sub)`
    : ''

  const rows = await db.select<{ fields: string; tags: string; deck: string; nt: string }>(
    `SELECT n.fields, n.tags, d.name AS deck, n.note_type AS nt
       FROM notes n JOIN decks d ON d.id = n.deck_id
       ${where}
      ORDER BY n.note_type, n.created_at`,
    deckId ? [deckId] : [],
  )
  if (!rows.length) return { rows: [], notes: 0 }

  // The union of every field name seen, in first-seen order, so a single-type
  // export reads exactly like its note type.
  const columns: string[] = []
  const parsed = rows.map((r) => {
    let fields: Record<string, string> = {}
    try {
      fields = JSON.parse(r.fields) as Record<string, string>
    } catch {
      fields = {}
    }
    for (const name of Object.keys(fields)) if (!columns.includes(name)) columns.push(name)
    return { fields, tags: r.tags, deck: r.deck }
  })

  return {
    rows: [
      [...columns, 'Tags', 'Deck'],
      ...parsed.map((p) => [
        ...columns.map((c) => p.fields[c] ?? ''),
        p.tags,
        p.deck,
      ]),
    ],
    notes: rows.length,
  }
}
