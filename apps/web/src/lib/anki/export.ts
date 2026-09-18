import {
  ANKI_SCHEMA_11, CONF_JSON, DCONF_JSON, ankiCardRow, ankiCsum, decksJson, joinFields,
  modelsJson, stripMedia, zip, type ExportDeck, type ExportNoteType,
} from '@recall/core'
import { db } from '@/db/client'
import * as repo from '@/db/repo'
import { mediaBytes } from '@/lib/media'

/**
 * Writing an `.apkg` Anki opens.
 *
 * This is half of what makes the importer testable — import, export, re-import,
 * and the note, card and review counts have to come back the same — and the
 * other half of "no lock-in": a collection you cannot get out of is a
 * collection you are stuck in.
 *
 * Two translations happen here and nowhere else. Ids become dense integers,
 * because Anki keys everything on 64-bit numbers where we use uuids and derived
 * strings — `guid` is what actually carries identity across (CARDS.md §4.5).
 * And media goes back to filenames, because Anki addresses it by name inside
 * one flat folder.
 */

const EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp',
  'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/mp4': 'm4a',
  'audio/opus': 'opus', 'audio/flac': 'flac', 'audio/webm': 'weba',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
}

const MEDIA_REF = /media\/([0-9a-f]{64})/g

export interface ExportReport {
  file: Blob
  notes: number
  cards: number
  reviews: number
  media: number
}

export async function exportApkg(deckId?: string | null): Promise<ExportReport> {
  const now = Date.now()
  const rows = await repo.collectionForExport(deckId)
  if (!rows.length) throw new Error('Nothing to export — that deck has no cards')

  const types = await repo.noteTypes()
  const paths = await repo.deckPaths()

  // ── ids ─────────────────────────────────────────────────────────────────
  // Anki ids are epoch milliseconds and only have to be unique; counting up
  // from now gives that, in one pass, with no lookups.
  let next = now
  const nextId = () => next++

  // Deck 1 is Anki's own Default and it must exist, so ours start after it.
  const deckIds = new Map<string, number>()
  const usedDecks = new Set(rows.flatMap((r) => [r.note.deck_id, ...r.cards.map((c) => c.deckId)]))
  const decks: ExportDeck[] = [{ did: 1, path: 'Default' }]
  for (const id of usedDecks) {
    const did = nextId()
    deckIds.set(id, did)
    decks.push({ did, path: paths.get(id) ?? 'Imported' })
  }

  const usedTypes = new Set(rows.map((r) => r.note.note_type))
  const models: ExportNoteType[] = []
  const midOf = new Map<string, number>()
  for (const nt of types.filter((t) => usedTypes.has(t.id))) {
    const mid = nextId()
    midOf.set(nt.id, mid)
    models.push({
      nt,
      mid,
      overrides: nt.templates.map((t) => (t.deckOverride ? deckIds.get(t.deckOverride) ?? null : null)),
    })
  }

  // ── media ───────────────────────────────────────────────────────────────
  const files = new Map<string, Uint8Array>()
  const manifest: Record<string, string> = {}
  const names = new Map<string, string>()

  for (const sha of collectMedia(rows)) {
    const row = await mediaBytes(sha)
    if (!row) continue
    // The hash stays the filename: it is already unique, which is exactly what
    // Anki's flat media folder needs, and it makes a re-import a no-op.
    const name = `${sha.slice(0, 32)}.${EXT[row.mime] ?? 'dat'}`
    manifest[String(files.size)] = name
    files.set(String(files.size), row.bytes)
    names.set(sha, name)
  }

  // ── rows ────────────────────────────────────────────────────────────────
  const stmts: { sql: string; params?: unknown[] }[] = ANKI_SCHEMA_11.map((sql) => ({ sql }))
  let cardCount = 0
  let reviewCount = 0
  let position = 0

  stmts.push({
    sql: `INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags)
          VALUES (1,?,?,?,11,0,-1,0,?,?,?,?,'{}')`,
    params: [
      Math.floor(startOfToday() / 1000), now, now,
      CONF_JSON, modelsJson(models, now), decksJson(decks, now), DCONF_JSON,
    ],
  })

  for (const row of rows) {
    const nt = types.find((t) => t.id === row.note.note_type)
    const mid = midOf.get(row.note.note_type)
    if (!nt || !mid) continue

    const fields = Object.fromEntries(
      nt.fields.map((f) => [f, toFilenames(row.note.fields[f] ?? '', names)]),
    )
    const sortField = fields[nt.fields[nt.sortField ?? 0] ?? ''] ?? ''
    const nid = nextId()

    stmts.push({
      sql: `INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data)
            VALUES (?,?,?,?,-1,?,?,?,?,0,'')`,
      params: [nid, row.note.guid, mid, Math.floor(row.note.updated_at / 1000),
               ` ${row.note.tags.join(' ')} `, joinFields(nt, fields),
               stripMedia(sortField), await ankiCsum(sortField)],
    })

    for (const card of row.cards) {
      const cid = nextId()
      const anki = ankiCardRow(card, position++, startOfToday(), now)
      stmts.push({
        sql: `INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl,
                factor, reps, lapses, left, odue, odid, flags, data)
              VALUES (?,?,?,?,?,-1,?,?,?,?,?,?,?,?,0,0,?,'')`,
        params: [cid, nid, deckIds.get(card.deckId) ?? 1, card.ord, anki.mod, anki.type,
                 anki.queue, anki.due, anki.ivl, anki.factor, anki.reps, anki.lapses,
                 anki.left, anki.flags],
      })
      cardCount++

      const history = row.reviews.filter((r) => r.card_id === card.id)
      history.forEach((review, i) => {
        stmts.push({
          sql: `INSERT INTO revlog (id, cid, usn, ease, ivl, lastIvl, factor, time, type)
                VALUES (?,?,-1,?,?,?,?,?,?)
                ON CONFLICT(id) DO NOTHING`,
          // Anki's revlog id is the review's own timestamp, which is also its
          // primary key — two answers in the same millisecond lose one, and
          // that is Anki's own behaviour rather than something to work around.
          //
          // Type: 0 learn, 1 review, 2 relearn. The first answer a card ever
          // got was a learning step by definition, and an `Again` after that is
          // a lapse — which is what Anki's own stats and FSRS both read.
          params: [review.ts, cid, review.rating, anki.ivl, anki.ivl, anki.factor,
                   review.duration_ms, i === 0 ? 0 : review.rating === 1 ? 2 : 1],
        })
        reviewCount++
      })
    }
  }

  const collection = await db.build(stmts)
  files.set('collection.anki2', collection)
  files.set('media', new TextEncoder().encode(JSON.stringify(manifest)))

  return {
    file: new Blob([await zip(sorted(files)) as unknown as ArrayBuffer],
                   { type: 'application/octet-stream' }),
    notes: rows.length,
    cards: cardCount,
    reviews: reviewCount,
    media: names.size,
  }
}

/**
 * The collection database first, then the manifest, then the media.
 *
 * Anki reads the archive sequentially and starts with `collection.anki2`; an
 * archive that buries it behind a gigabyte of images makes the import look
 * hung before it has read anything.
 */
function sorted(files: Map<string, Uint8Array>): Map<string, Uint8Array> {
  const order = ['collection.anki2', 'media']
  return new Map([
    ...order.filter((n) => files.has(n)).map((n) => [n, files.get(n)!] as const),
    ...[...files].filter(([n]) => !order.includes(n)),
  ])
}

/** Every media hash the exported notes refer to. */
function collectMedia(rows: repo.ExportRow[]): Set<string> {
  const out = new Set<string>()
  for (const row of rows)
    for (const value of Object.values(row.note.fields))
      for (const m of String(value).matchAll(MEDIA_REF)) out.add(m[1]!)
  return out
}

/**
 * `media/<sha>` → the filename this export gave those bytes.
 *
 * A plain substitution rather than the importer's attribute-aware rewrite: our
 * own references are one unambiguous shape, and they appear inside `src="…"`
 * and `[sound:…]` alike. A hash with no file behind it keeps its reference, so
 * the broken image is visible instead of silently deleted.
 */
const toFilenames = (html: string, names: Map<string, string>): string =>
  html.replace(MEDIA_REF, (whole, sha: string) => names.get(sha) ?? whole)

const startOfToday = () => new Date(new Date().setHours(0, 0, 0, 0)).getTime()
