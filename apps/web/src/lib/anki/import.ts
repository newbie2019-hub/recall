import {
  countLatex, countNotes, detectSchema, mediaNames, normaliseOcclusion, parseAnkiOcclusion,
  readCards, readCreated, readDecks, readNoteTypes, readNotes, readReviews, rewriteMedia,
  type AnkiCard, type AnkiSelect, type NoteType, type RatingValue,
} from '@recall/core'
import { db } from '@/db/client'
import * as repo from '@/db/repo'
import { mediaRef, mimeOf, storeBytes } from '@/lib/media'
import { imageSize, openApkg } from './apkg'

/**
 * Importing an `.apkg`.
 *
 * The order is forced by what depends on what: media before notes, because a
 * note's fields are rewritten onto content hashes; note types before notes,
 * because generation needs the templates; decks before cards, because a card
 * has to land somewhere. Notes come through in pages so that a 20,000-card
 * deck reports progress instead of freezing for a minute.
 *
 * Everything matches on **guid**. Import the same deck twice and the second run
 * updates in place; import v2 of a shared deck and your scheduling survives.
 */

export interface ImportProgress {
  stage: 'reading' | 'media' | 'notes' | 'done'
  done: number
  total: number
}

export interface ImportReport {
  notesAdded: number
  notesUpdated: number
  noteTypes: number
  decks: number
  media: number
  reviews: number
  /** Notes using `[latex]`, which KaTeX cannot render (PHASES.md, Phase 4). */
  latexNotes: number
  /** Occlusion notes whose image could not be measured, so their masks were left. */
  occlusionSkipped: number
}

const PAGE = 250

export async function importApkg(
  file: Blob,
  onProgress: (p: ImportProgress) => void = () => {},
): Promise<ImportReport> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  onProgress({ stage: 'reading', done: 0, total: 0 })

  const apkg = await openApkg(bytes)
  await db.attach(apkg.collection)
  try {
    return await ingest(apkg.media, onProgress)
  } finally {
    // The foreign collection is a copy in the worker's heap; letting it sit
    // there would cost the size of the deck for the rest of the session.
    await db.detach()
  }
}

async function ingest(
  mediaFiles: Map<string, () => Promise<Uint8Array>>,
  onProgress: (p: ImportProgress) => void,
): Promise<ImportReport> {
  const select: AnkiSelect = (sql, params) => db.attachSelect(sql, params) as any
  const schema = await detectSchema(select)
  const created = await readCreated(select)

  // ── media ───────────────────────────────────────────────────────────────
  const hashes = new Map<string, string>()
  let mediaDone = 0
  for (const [name, read] of mediaFiles) {
    hashes.set(name, await storeBytes(await read(), mimeOf(name)))
    onProgress({ stage: 'media', done: ++mediaDone, total: mediaFiles.size })
  }

  // ── decks ───────────────────────────────────────────────────────────────
  const paths = await readDecks(select, schema)
  const deckIds = new Map<string, string>()
  for (const [did, path] of paths) deckIds.set(did, await repo.deckByPath(path))

  // ── note types ──────────────────────────────────────────────────────────
  const imported = await readNoteTypes(select, schema)
  const types: NoteType[] = imported.map(({ mid, noteType }) => ({
    ...noteType,
    // Namespaced so an Anki id can never collide with `basic` or a type the
    // user made, and stable so a re-import updates rather than duplicates.
    id: `anki:${mid}`,
    templates: noteType.templates.map((t) => ({
      ...t,
      // The override arrives as an Anki deck id and has to become one of ours.
      deckOverride: t.deckOverride ? deckIds.get(t.deckOverride) ?? null : null,
    })),
  }))
  await repo.upsertNoteTypes(types)
  const byMid = new Map(imported.map((t, i) => [t.mid, types[i]!]))

  // ── notes, cards and history ────────────────────────────────────────────
  const total = await countNotes(select)
  const report: ImportReport = {
    notesAdded: 0, notesUpdated: 0, noteTypes: types.length, decks: paths.size,
    media: hashes.size, reviews: 0, latexNotes: await countLatex(select), occlusionSkipped: 0,
  }

  const resolve = (name: string) => {
    const sha = hashes.get(name)
    return sha ? mediaRef(sha) : null
  }

  for (let offset = 0; offset < total; offset += PAGE) {
    const page = await readNotes(select, PAGE, offset)
    if (!page.length) break

    const cards = await readCards(select, page.map((n) => n.id))
    const reviews = cards.length ? await readReviews(select, cards.map((c) => c.id)) : []
    report.reviews += reviews.length

    const batch: repo.ImportedNote[] = []
    for (const note of page) {
      const nt = byMid.get(note.mid)
      // A note whose type did not come with the deck cannot be rendered, and
      // inventing one would put its content in boxes nobody chose.
      if (!nt) continue

      const fields: Record<string, string> = {}
      nt.fields.forEach((name, i) => {
        fields[name] = rewriteMedia(note.fields[i] ?? '', resolve)
      })
      if (nt.kind === 'occlusion' && !(await convertOcclusion(fields, nt, hashes)))
        report.occlusionSkipped++

      const mine = cards.filter((c) => c.nid === note.id)
      const deckOf = (c: AnkiCard) =>
        // `odid` is the card's home deck while it sits in a filtered deck; the
        // filtered deck itself is a view, and Phase 7 builds our own.
        deckIds.get(String(c.odid || c.did)) ?? null
      const home = (mine[0] && deckOf(mine[0])) ?? deckIds.get('1') ?? await repo.deckByPath('Imported')

      batch.push({
        guid: note.guid,
        noteTypeId: nt.id,
        deckId: home,
        fields,
        tags: note.tags,
        mod: note.mod * 1000,
        cardDecks: Object.fromEntries(
          mine.map((c) => [c.ord, deckOf(c) === home ? null : deckOf(c)]),
        ),
        reviews: mine.flatMap((c) =>
          reviews.filter((r) => r.cid === c.id).map((r) => ({
            ord: c.ord,
            ts: r.id, // Anki's revlog id is the review's epoch-millisecond time.
            rating: Math.min(4, Math.max(1, r.ease)) as RatingValue,
            durationMs: r.time,
          })),
        ),
      })
    }

    const written = await repo.importNotes(batch, types)
    report.notesAdded += written.added
    report.notesUpdated += written.updated
    onProgress({ stage: 'notes', done: Math.min(offset + PAGE, total), total })
  }

  onProgress({ stage: 'done', done: total, total })
  return report
}

/**
 * Anki's image-occlusion shapes are pixels against the image's natural size;
 * ours are 0–1 so a mask survives the image being re-encoded. Measuring is the
 * only way across, and it needs the image bytes — which the media pass has
 * just stored.
 *
 * Returns false when the image could not be measured. The field is then left
 * exactly as Anki wrote it, and the card renders as the bare plate: visibly
 * missing its masks, rather than wearing masks in the wrong places.
 */
async function convertOcclusion(
  fields: Record<string, string>,
  nt: NoteType,
  hashes: Map<string, string>,
): Promise<boolean> {
  const field = nt.ordField ?? 'Occlusion'
  const occ = parseAnkiOcclusion(fields[field] ?? '')
  if (!occ.shapes.length) return true

  const name = mediaNames(fields.Image ?? '')[0]
  const sha = (fields.Image ?? '').match(/media\/([0-9a-f]{64})/)?.[1]
    ?? (name ? hashes.get(name) : undefined)
  if (!sha) return false

  const { mediaBytes } = await import('@/lib/media')
  const row = await mediaBytes(sha)
  const size = row ? await imageSize(row.bytes, row.mime) : null
  const json = size && normaliseOcclusion(occ, size.width, size.height)
  if (!json) return false

  fields[field] = json
  return true
}
