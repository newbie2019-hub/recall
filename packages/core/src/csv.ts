/**
 * CSV and TSV: the format everybody already has their cards in.
 *
 * Spreadsheets, Quizlet exports, a language course's word list, the table a
 * lecturer handed out — none of it is an `.apkg`, and until now none of it
 * could get in. This is the cheapest import we will ever ship and probably the
 * widest door into the app.
 *
 * RFC 4180 for quoting, which is what Excel, Numbers and Sheets all write:
 * fields containing a delimiter, a quote or a newline are wrapped in `"`, and
 * an embedded `"` is doubled. The parser handles all three; a naive `split(',')`
 * handles none of them, and the first field anybody exports from a flashcard
 * app is prose with a comma in it.
 *
 * Pure string work with no DOM and no `File`, so it lives in core and the
 * mobile app inherits it.
 */

export type Delimiter = ',' | '\t' | ';'

/**
 * Guess the delimiter from the first line.
 *
 * Counting outside quotes matters: `"Smith, John",x` is one comma inside a
 * field and one real separator, and a naive count makes comma win a file that
 * is plainly tab-separated.
 */
export function sniffDelimiter(text: string): Delimiter {
  const line = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'))
  const counts: [Delimiter, number][] = [',', '\t', ';'].map((d) => {
    let n = 0
    let quoted = false
    for (const ch of line) {
      if (ch === '"') quoted = !quoted
      else if (ch === d && !quoted) n++
    }
    return [d as Delimiter, n]
  })
  // Tabs win ties: a file with one tab per line and one comma per line is a TSV
  // whose fields contain prose, never the other way round.
  const best = counts.sort((a, b) => b[1] - a[1] || (a[0] === '\t' ? -1 : 1))[0]!
  return best[1] > 0 ? best[0] : ','
}

/**
 * Parse into rows of strings. Never throws.
 *
 * A malformed file is a file with odd-looking rows, not an exception: this is
 * somebody's export from a tool neither of us has seen, and the import screen
 * can show them what it made of it. Unterminated quotes simply run to the end.
 */
export function parseCsv(text: string, delimiter: Delimiter = sniffDelimiter(text)): string[][] {
  // A BOM is what Excel writes, and it would otherwise live inside the first
  // header and stop it matching a field name by one invisible character.
  const src = text.replace(/^﻿/, '')

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0

  const endField = () => { row.push(field); field = '' }
  const endRow = () => {
    endField()
    // A trailing newline is not an empty last record.
    if (row.length > 1 || row[0] !== '') rows.push(row)
    row = []
  }

  while (i < src.length) {
    const ch = src[i]!

    if (quoted) {
      if (ch === '"') {
        // `""` inside a quoted field is one literal quote.
        if (src[i + 1] === '"') { field += '"'; i += 2; continue }
        quoted = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }

    if (ch === '"' && field === '') { quoted = true; i++; continue }
    if (ch === delimiter) { endField(); i++; continue }
    if (ch === '\r') { i++; continue }
    if (ch === '\n') { endRow(); i++; continue }

    field += ch
    i++
  }

  if (field !== '' || row.length) endRow()
  return rows
}

/** One row back out, quoted only where it has to be. */
export function toCsvRow(values: string[], delimiter: Delimiter = ','): string {
  return values.map((v) => {
    const s = v ?? ''
    return /["\n\r]/.test(s) || s.includes(delimiter)
      ? `"${s.replace(/"/g, '""')}"`
      : s
  }).join(delimiter)
}

export function toCsv(rows: string[][], delimiter: Delimiter = ','): string {
  // CRLF, because that is what RFC 4180 says and what Excel expects; every
  // other reader accepts it.
  return rows.map((r) => toCsvRow(r, delimiter)).join('\r\n')
}

/**
 * Does the first row name fields, or is it a card?
 *
 * Getting this wrong in either direction is a visible error — a note whose
 * front is "Front" or a missing first card — so it is offered as a guess the
 * import screen shows a toggle for, never decided silently.
 *
 * The guess: a header row's cells all look like field names, and at least one
 * matches a field of the chosen note type.
 */
export function looksLikeHeader(first: string[], fieldNames: string[]): boolean {
  if (!first.length) return false
  const lower = fieldNames.map((f) => f.toLowerCase())
  const named = first.filter((c) => lower.includes(c.trim().toLowerCase())).length
  if (named === 0) return false
  // Every cell short and single-line: a header, not a card that happens to
  // start with the word "Front".
  return first.every((c) => c.length <= 40 && !c.includes('\n'))
}

export interface CsvMapping {
  /** Target field name per column, or null to ignore the column. */
  fields: (string | null)[]
  /** The column holding space- or comma-separated tags, if any. */
  tagColumn: number | null
  /** The column naming a deck per row, if any. */
  deckColumn: number | null
  hasHeader: boolean
}

/**
 * A first guess at the mapping, which the screen then lets you correct.
 *
 * With a header, columns are matched to fields by name. Without one, they are
 * taken in order — which is what "Front, Back" files are, and what anybody
 * pasting two columns expects.
 */
export function guessMapping(rows: string[][], fieldNames: string[]): CsvMapping {
  const first = rows[0] ?? []
  const hasHeader = looksLikeHeader(first, fieldNames)

  if (!hasHeader) {
    return {
      fields: first.map((_, i) => fieldNames[i] ?? null),
      tagColumn: null,
      deckColumn: null,
      hasHeader: false,
    }
  }

  const byName = new Map(fieldNames.map((f) => [f.toLowerCase(), f]))
  const fields = first.map((c) => byName.get(c.trim().toLowerCase()) ?? null)
  const named = (want: string) =>
    first.findIndex((c) => c.trim().toLowerCase() === want)

  return {
    fields,
    tagColumn: named('tags') === -1 ? null : named('tags'),
    deckColumn: named('deck') === -1 ? null : named('deck'),
    hasHeader: true,
  }
}

export interface CsvNote {
  fields: Record<string, string>
  tags: string[]
  /** The deck named in this row, if the mapping has a deck column. */
  deck: string | null
}

/**
 * Rows plus a mapping into notes.
 *
 * Rows whose mapped fields are all empty are dropped: a spreadsheet's trailing
 * blank lines are not cards, and importing them makes a deck whose count is
 * right and whose contents are not.
 */
export function toNotes(rows: string[][], mapping: CsvMapping): CsvNote[] {
  const body = mapping.hasHeader ? rows.slice(1) : rows

  return body.flatMap((row) => {
    const fields: Record<string, string> = {}
    for (const [i, target] of mapping.fields.entries()) {
      if (target) fields[target] = row[i] ?? ''
    }
    if (!Object.values(fields).some((v) => v.trim() !== '')) return []

    const rawTags = mapping.tagColumn === null ? '' : row[mapping.tagColumn] ?? ''
    return [{
      fields,
      // Space or comma, because both are in the wild and neither is valid
      // inside one of our tags.
      tags: rawTags.split(/[\s,]+/).filter(Boolean),
      deck: mapping.deckColumn === null ? null : (row[mapping.deckColumn] ?? '').trim() || null,
    }]
  })
}
