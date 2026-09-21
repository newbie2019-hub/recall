/**
 * Reading an Anki collection — both schemas, one shape out.
 *
 * Anki 2.1.50 moved note types and decks out of JSON blobs in the `col` table
 * into real tables with protobuf config columns, and called it schema 18. Both
 * are still in the wild: every shared deck published before 2022 is schema 11,
 * and every export made since is 18. The `notes`, `cards` and `revlog` tables
 * are identical in both, so only these two definitions have to fork.
 *
 * Nothing here opens a database. The caller passes a `select`, which the web
 * app backs with the same sqlite-wasm worker that owns the local collection and
 * React Native will back with op-sqlite.
 */
import type { CardTemplate, FieldConfig, NoteType } from '../notetypes.ts'
import { decodeProto, protoInt, protoString, type ProtoMessage } from './proto.ts'

export type AnkiSelect = <T = Record<string, any>>(sql: string, params?: unknown[]) => Promise<T[]>

/** `::` in schema 11, an ASCII unit separator in 18. */
const SEP_18 = '\x1f'
export const FIELD_SEP = '\x1f'

/** Anki's `StockNotetype.Kind`. Only image occlusion changes what we do. */
const STOCK_IMAGE_OCCLUSION = 5

export interface AnkiNoteType {
  /** Anki's own note type id, which `notes.mid` points at. */
  mid: string
  noteType: NoteType
}

export async function detectSchema(select: AnkiSelect): Promise<11 | 18> {
  const [row] = await select<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notetypes'`,
  )
  return row ? 18 : 11
}

// ── note types ────────────────────────────────────────────────────────────

/**
 * Which of our kinds an Anki note type is.
 *
 * `kind` is only ever normal or cloze — image occlusion is a cloze note type
 * wearing a stock-kind marker, because Anki generates its cards from cloze
 * ordinals in the `Occlusion` field. We model it as its own kind, so the marker
 * is the only thing that can tell us.
 *
 * A simulation has no marker to wear, because Anki has no concept it could
 * borrow: there, it is an ordinary note type whose fields happen to spell out a
 * model and its parameters. So it is recognised the same way occlusion is —
 * by the fields that make it one — and anywhere else it stays a plain note,
 * which is the honest outcome rather than a lossy one.
 */
const SIMULATION_FIELDS = ['Prompt', 'Model', 'Parameters', 'Target']

function kindOf(kind: number, stock: number, fields: string[]): NoteType['kind'] {
  if (stock === STOCK_IMAGE_OCCLUSION && fields.includes('Occlusion')) return 'occlusion'
  if (kind === 0 && SIMULATION_FIELDS.every((f) => fields.includes(f))) return 'simulation'
  return kind === 1 ? 'cloze' : 'standard'
}

const clampSort = (sortf: number, fields: string[]) =>
  Math.min(Math.max(0, sortf), Math.max(0, fields.length - 1))

/** Schema 11: one JSON object in `col.models`, keyed by note type id. */
async function noteTypes11(select: AnkiSelect): Promise<AnkiNoteType[]> {
  const [row] = await select<{ models: string }>('SELECT models FROM col LIMIT 1')
  const models: Record<string, any> = JSON.parse(row?.models || '{}')

  return Object.entries(models).map(([mid, m]) => {
    const fields: string[] = (m.flds ?? [])
      .slice()
      .sort((a: any, b: any) => a.ord - b.ord)
      .map((f: any) => String(f.name))
    const templates: CardTemplate[] = (m.tmpls ?? [])
      .slice()
      .sort((a: any, b: any) => a.ord - b.ord)
      .map((t: any) => ({
        name: String(t.name ?? ''),
        qfmt: String(t.qfmt ?? ''),
        afmt: String(t.afmt ?? ''),
        // `did` is the template deck override, and it is an Anki deck id. The
        // importer swaps it for ours once the decks exist.
        deckOverride: t.did ? String(t.did) : null,
      }))

    return {
      mid,
      noteType: {
        id: mid,
        name: String(m.name ?? 'Imported'),
        fields,
        templates,
        css: String(m.css ?? ''),
        kind: kindOf(Number(m.type ?? 0), Number(m.originalStockKind ?? -1), fields),
        ordField: fields.includes('Occlusion') ? 'Occlusion' : undefined,
        sortField: clampSort(Number(m.sortf ?? 0), fields),
        fieldConfig: (m.flds ?? []).map((f: any): FieldConfig => ({
          sticky: !!f.sticky, rtl: !!f.rtl, description: f.description || undefined,
        })),
        ankiExtra: carried(m, (m.tmpls ?? [])),
      },
    }
  })
}

/** Schema 18: three tables, with the formats inside protobuf config blobs. */
async function noteTypes18(select: AnkiSelect): Promise<AnkiNoteType[]> {
  const types = await select<{ id: number; name: string; config: Uint8Array }>(
    'SELECT id, name, config FROM notetypes',
  )
  const fieldRows = await select<{ ntid: number; ord: number; name: string; config: Uint8Array }>(
    'SELECT ntid, ord, name, config FROM fields ORDER BY ntid, ord',
  )
  const tmplRows = await select<{ ntid: number; ord: number; name: string; config: Uint8Array }>(
    'SELECT ntid, ord, name, config FROM templates ORDER BY ntid, ord',
  )

  return types.map((t) => {
    const cfg = decodeProto(t.config)
    const mine = fieldRows.filter((f) => f.ntid === t.id)
    const fields = mine.map((f) => f.name)
    const templates: CardTemplate[] = tmplRows
      .filter((x) => x.ntid === t.id)
      .map((x) => {
        const c = decodeProto(x.config)
        const did = protoInt(c, 5)
        return {
          name: x.name,
          qfmt: protoString(c, 1),
          afmt: protoString(c, 2),
          deckOverride: did ? String(did) : null,
        }
      })

    return {
      mid: String(t.id),
      noteType: {
        id: String(t.id),
        name: t.name,
        fields,
        templates,
        css: protoString(cfg, 3),
        kind: kindOf(protoInt(cfg, 1), protoInt(cfg, 9, -1), fields),
        ordField: fields.includes('Occlusion') ? 'Occlusion' : undefined,
        sortField: clampSort(protoInt(cfg, 2), fields),
        fieldConfig: mine.map((f): FieldConfig => {
          const c = decodeProto(f.config)
          return {
            sticky: protoInt(c, 1) !== 0,
            rtl: protoInt(c, 2) !== 0,
            description: protoString(c, 5) || undefined,
          }
        }),
        ankiExtra: {
          latexPre: protoString(cfg, 5),
          latexPost: protoString(cfg, 6),
          latexsvg: protoInt(cfg, 7) !== 0,
          originalStockKind: protoInt(cfg, 9, -1),
          tmpls: tmplRows.filter((x) => x.ntid === t.id).map((x) => browserFormats(decodeProto(x.config))),
        },
      },
    }
  })
}

const browserFormats = (c: ProtoMessage) => ({ bqfmt: protoString(c, 3), bafmt: protoString(c, 4) })

/**
 * The note-type fields we do not model, kept verbatim.
 *
 * An export that quietly drops `latexPre` degrades the deck for everyone who
 * imports it back into Anki — the `\usepackage` line that made its formulae
 * render lives there (CARDS.md §7). They exist to survive a round-trip, so they
 * ride in one column and are never queried.
 */
const carried = (m: any, tmpls: any[]) => ({
  latexPre: m.latexPre ?? '',
  latexPost: m.latexPost ?? '',
  latexsvg: !!m.latexsvg,
  originalStockKind: m.originalStockKind ?? -1,
  tmpls: tmpls.map((t: any) => ({ bqfmt: t.bqfmt ?? '', bafmt: t.bafmt ?? '' })),
})

export const readNoteTypes = async (select: AnkiSelect, schema: 11 | 18): Promise<AnkiNoteType[]> =>
  schema === 18 ? noteTypes18(select) : noteTypes11(select)

// ── decks ─────────────────────────────────────────────────────────────────

/**
 * Anki deck id → its full path, always spelled with `::`.
 *
 * Schema 18 separates the components with an ASCII unit separator so that a
 * deck may legally contain "::" in its name; schema 11 uses "::" itself and
 * forbids it inside a name. Normalising to `::` here means `deckByPath` is the
 * only thing that has to know about deck trees.
 */
export async function readDecks(select: AnkiSelect, schema: 11 | 18): Promise<Map<string, string>> {
  if (schema === 18) {
    const rows = await select<{ id: number; name: string }>('SELECT id, name FROM decks')
    return new Map(rows.map((d) => [String(d.id), d.name.split(SEP_18).join('::')]))
  }
  const [row] = await select<{ decks: string }>('SELECT decks FROM col LIMIT 1')
  const decks: Record<string, any> = JSON.parse(row?.decks || '{}')
  return new Map(Object.entries(decks).map(([did, d]) => [did, String(d.name ?? 'Imported')]))
}

/** Day zero for the collection, which every review card's `due` counts from. */
export async function readCreated(select: AnkiSelect): Promise<number> {
  const [row] = await select<{ crt: number }>('SELECT crt FROM col LIMIT 1')
  return (row?.crt ?? 0) * 1000
}

// ── notes, cards, reviews ─────────────────────────────────────────────────

export interface AnkiNote {
  id: number
  guid: string
  mid: string
  tags: string[]
  fields: string[]
  mod: number
}

export interface AnkiCard {
  id: number
  nid: number
  did: number
  odid: number
  ord: number
  type: number
  queue: number
  due: number
  ivl: number
}

export interface AnkiReview {
  id: number
  cid: number
  ease: number
  time: number
}

export const readNotes = (select: AnkiSelect, limit: number, offset: number) =>
  select<{ id: number; guid: string; mid: number; tags: string; flds: string; mod: number }>(
    'SELECT id, guid, mid, tags, flds, mod FROM notes ORDER BY id LIMIT ? OFFSET ?',
    [limit, offset],
  ).then((rows) =>
    rows.map((r): AnkiNote => ({
      id: r.id,
      guid: r.guid,
      mid: String(r.mid),
      // Anki pads the tag string with a space at each end so `LIKE '% tag %'`
      // works; splitting on whitespace drops the padding for free.
      tags: String(r.tags ?? '').split(/\s+/).filter(Boolean),
      fields: String(r.flds ?? '').split(FIELD_SEP),
      mod: r.mod,
    })),
  )

export const countNotes = (select: AnkiSelect) =>
  select<{ n: number }>('SELECT COUNT(*) AS n FROM notes').then((r) => r[0]?.n ?? 0)

export const readCards = (select: AnkiSelect, noteIds: number[]) =>
  select<AnkiCard>(
    `SELECT id, nid, did, odid, ord, type, queue, due, ivl FROM cards
      WHERE nid IN (${noteIds.map(() => '?').join(',')})`,
    noteIds,
  )

/**
 * The review log for a set of cards, oldest first.
 *
 * `type = 4` is a manual reschedule and `ease = 0` is a rescheduled or reset
 * entry — neither is an answer a person gave, and feeding them to FSRS as one
 * would invent a rating that never happened.
 */
export const readReviews = (select: AnkiSelect, cardIds: number[]) =>
  select<AnkiReview>(
    `SELECT id, cid, ease, time FROM revlog
      WHERE cid IN (${cardIds.map(() => '?').join(',')})
        AND ease BETWEEN 1 AND 4 AND type != 4
      ORDER BY id`,
    cardIds,
  )

/**
 * How many notes use `[latex]` blocks, which KaTeX cannot render.
 *
 * PHASES.md asks for this number rather than a decision: `\begin{tabular}` and
 * `tikz` inside `[latex]…[/latex]` need a real TeX run, and it is worth knowing
 * whether that is one deck in a hundred or one note in three before building a
 * render job for it.
 */
export const countLatex = (select: AnkiSelect) =>
  select<{ n: number }>(
    `SELECT COUNT(*) AS n FROM notes WHERE flds LIKE '%[latex]%' OR flds LIKE '%[$%'`,
  ).then((r) => r[0]?.n ?? 0)
