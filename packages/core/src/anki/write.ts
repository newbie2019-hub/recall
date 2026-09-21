/**
 * Writing an `.apkg` Anki will open.
 *
 * The export is **schema 11**, the legacy format, on purpose: every Anki since
 * 2.0 reads it, it needs no zstd encoder, and it is the format shared decks are
 * still published in. Schema 18 would buy nothing a user can see.
 *
 * ponytail: schema 11 out, both schemas in. Write 18 the day Anki stops
 * accepting 11 — the note type mapping is the only part that would change, and
 * `read.ts` already models both sides of it.
 *
 * Ids are Anki's shape, not ours: it keys everything on 64-bit integers where
 * we use uuids and derived strings. `guid` is what actually carries identity
 * across the boundary (CARDS.md §4.5), so the integers are just dense numbering
 * assigned at export time.
 */
import { stripHtml } from '../html.ts'
import type { NoteType } from '../notetypes.ts'
import { FIELD_SEP } from './read.ts'

/** Anki's own DDL for schema 11, trimmed to the tables an import reads. */
export const ANKI_SCHEMA_11: string[] = [
  `CREATE TABLE col (
     id integer PRIMARY KEY, crt integer NOT NULL, mod integer NOT NULL,
     scm integer NOT NULL, ver integer NOT NULL, dty integer NOT NULL,
     usn integer NOT NULL, ls integer NOT NULL, conf text NOT NULL,
     models text NOT NULL, decks text NOT NULL, dconf text NOT NULL, tags text NOT NULL)`,
  `CREATE TABLE notes (
     id integer PRIMARY KEY, guid text NOT NULL, mid integer NOT NULL,
     mod integer NOT NULL, usn integer NOT NULL, tags text NOT NULL,
     flds text NOT NULL, sfld integer NOT NULL, csum integer NOT NULL,
     flags integer NOT NULL, data text NOT NULL)`,
  `CREATE TABLE cards (
     id integer PRIMARY KEY, nid integer NOT NULL, did integer NOT NULL,
     ord integer NOT NULL, mod integer NOT NULL, usn integer NOT NULL,
     type integer NOT NULL, queue integer NOT NULL, due integer NOT NULL,
     ivl integer NOT NULL, factor integer NOT NULL, reps integer NOT NULL,
     lapses integer NOT NULL, left integer NOT NULL, odue integer NOT NULL,
     odid integer NOT NULL, flags integer NOT NULL, data text NOT NULL)`,
  `CREATE TABLE revlog (
     id integer PRIMARY KEY, cid integer NOT NULL, usn integer NOT NULL,
     ease integer NOT NULL, ivl integer NOT NULL, lastIvl integer NOT NULL,
     factor integer NOT NULL, time integer NOT NULL, type integer NOT NULL)`,
  `CREATE TABLE graves (usn integer NOT NULL, oid integer NOT NULL, type integer NOT NULL)`,
  `CREATE INDEX ix_notes_usn ON notes (usn)`,
  `CREATE INDEX ix_cards_usn ON cards (usn)`,
  `CREATE INDEX ix_revlog_usn ON revlog (usn)`,
  `CREATE INDEX ix_cards_nid ON cards (nid)`,
  `CREATE INDEX ix_cards_sched ON cards (did, queue, due)`,
  `CREATE INDEX ix_revlog_cid ON revlog (cid)`,
  `CREATE INDEX ix_notes_csum ON notes (csum)`,
  `PRAGMA user_version = 11`,
]

/** `stripHTMLMedia` — what Anki stores in `sfld` and checksums. */
export const stripMedia = (s: string) =>
  stripHtml(s.replace(/\[sound:[^\]]*\]/g, '').replace(/\[anki:[^\]]*\]/g, '')).trim()

/**
 * Anki's `csum`: the first 8 hex digits of the SHA-1 of the sort field.
 *
 * This is the one place our own FNV checksum is not interchangeable
 * (`identity.ts`) — Anki compares this number against its own collection, so it
 * has to be bit-for-bit its algorithm or its duplicate finder goes quiet.
 */
export async function ankiCsum(sortField: string): Promise<number> {
  const bytes = new TextEncoder().encode(stripMedia(sortField))
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes))
  return [...hash.subarray(0, 4)].reduce((n, b) => n * 256 + b, 0)
}

/**
 * `req` — which fields a template needs before it makes a card.
 *
 * Anki 2.1 recomputes this on import, but a legacy `.apkg` with the key missing
 * is rejected outright by older builds. "any of these fields" over every field
 * is the permissive answer, and permissive is right: our own generation rule
 * (`generatedOrds`) is the authority on this side.
 */
const reqFor = (nt: NoteType) =>
  nt.templates.map((_, ord) => [ord, 'any', nt.fields.map((__, i) => i)])

export interface ExportNoteType {
  nt: NoteType
  /** Anki id assigned at export. */
  mid: number
  /** Anki deck ids for each template's override, by ordinal. */
  overrides: (number | null)[]
}

export function modelsJson(types: ExportNoteType[], now: number): string {
  return JSON.stringify(Object.fromEntries(types.map(({ nt, mid, overrides }) => {
    const extra = (nt.ankiExtra ?? {}) as Record<string, any>
    const browser: { bqfmt?: string; bafmt?: string }[] = Array.isArray(extra.tmpls) ? extra.tmpls : []
    return [String(mid), {
      id: mid,
      name: nt.name,
      // Occlusion is a cloze note type as far as Anki is concerned — that is
      // what it is there, and what `read.ts` recognises coming back. A
      // simulation is *not*: it has no cloze markers, so calling it cloze
      // makes it generate no cards at all, and notes with no cards do not
      // survive the next export.
      type: nt.kind === 'cloze' || nt.kind === 'occlusion' ? 1 : 0,
      mod: Math.floor(now / 1000),
      usn: -1,
      sortf: nt.sortField ?? 0,
      did: 1,
      css: nt.css,
      latexPre: extra.latexPre ?? '',
      latexPost: extra.latexPost ?? '',
      latexsvg: !!extra.latexsvg,
      originalStockKind: extra.originalStockKind ?? (nt.kind === 'occlusion' ? 5 : 0),
      req: reqFor(nt),
      flds: nt.fields.map((name, ord) => ({
        name, ord, sticky: !!nt.fieldConfig?.[ord]?.sticky, rtl: !!nt.fieldConfig?.[ord]?.rtl,
        font: 'Arial', size: 20, media: [], description: nt.fieldConfig?.[ord]?.description ?? '',
      })),
      tmpls: nt.templates.map((t, ord) => ({
        name: t.name, ord, qfmt: t.qfmt, afmt: t.afmt,
        did: overrides[ord] ?? null,
        bqfmt: browser[ord]?.bqfmt ?? '',
        bafmt: browser[ord]?.bafmt ?? '',
      })),
    }]
  })))
}

export interface ExportDeck {
  /** Anki id assigned at export. */
  did: number
  /** Full `A::B::C` path. */
  path: string
}

export function decksJson(decks: ExportDeck[], now: number): string {
  const secs = Math.floor(now / 1000)
  return JSON.stringify(Object.fromEntries(decks.map(({ did, path }) => [String(did), {
    id: did, name: path, mod: secs, usn: -1, collapsed: false, desc: '',
    dyn: 0, conf: 1, extendNew: 0, extendRev: 0, newToday: [0, 0], revToday: [0, 0],
    lrnToday: [0, 0], timeToday: [0, 0],
  }])))
}

/** One deck config, referenced by every deck. Anki refuses a collection without it. */
export const DCONF_JSON = JSON.stringify({
  '1': {
    id: 1, name: 'Default', mod: 0, usn: -1, maxTaken: 60, autoplay: true, timer: 0, replayq: true,
    new: { bury: false, delays: [1, 10], initialFactor: 2500, ints: [1, 4, 0], order: 1, perDay: 20 },
    rev: { bury: false, ease4: 1.3, ivlFct: 1, maxIvl: 36500, perDay: 200, hardFactor: 1.2 },
    lapse: { delays: [10], leechAction: 1, leechFails: 8, minInt: 1, mult: 0 },
    dyn: 0,
  },
})

export const CONF_JSON = JSON.stringify({
  nextPos: 1, estTimes: true, activeDecks: [1], sortType: 'noteFld', timeLim: 0,
  sortBackwards: false, addToCur: true, curDeck: 1, newBury: true, newSpread: 0,
  dueCounts: true, curModel: null, collapseTime: 1200, schedVer: 2,
})

export const joinFields = (nt: NoteType, fields: Record<string, string>): string =>
  nt.fields.map((f) => fields[f] ?? '').join(FIELD_SEP)

/**
 * Our card state in Anki's columns.
 *
 * Anki's own scheduler does not speak stability and difficulty, so the interval
 * and ease are a translation, not a transfer — but the **review log goes over
 * intact**, and that is the copy that matters: an FSRS-enabled Anki rebuilds
 * exactly these numbers from it, and so would we on the way back.
 */
export function ankiCardRow(card: {
  state: string; due: number; last_review: number | null; reps: number
  lapses: number; suspended: boolean; flag: number
}, position: number, created: number, now: number) {
  const day = 86_400_000
  const type = { new: 0, learning: 1, review: 2, relearning: 3 }[card.state] ?? 0
  const ivl = card.last_review ? Math.max(1, Math.round((card.due - card.last_review) / day)) : 0
  const due =
    type === 0 ? position
    : type === 2 ? Math.round((card.due - created) / day)
    : Math.round(card.due / 1000)
  return {
    type,
    queue: card.suspended ? -1 : type,
    due,
    ivl,
    // 2500 is Anki's own starting ease; its scheduler moves off it on the first
    // answer it sees, and the exported log gives it plenty to move on.
    factor: type === 0 ? 0 : 2500,
    reps: card.reps,
    lapses: card.lapses,
    left: 0,
    flags: card.flag,
    mod: Math.floor(now / 1000),
  }
}
