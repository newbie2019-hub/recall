import { GRADE_BATCH, type AiVerdict } from '@recall/core'
import { db } from '../client.ts'

/**
 * The card doctor's local half: which cards still need grading, and what the
 * grader said about the ones it has seen.
 *
 * **Verdicts are cached because grading costs money.** Re-sweeping a
 * 20,000-card import every time somebody opens this screen would be a bill
 * rather than a refresh, so a verdict is kept until the card it was about
 * changes.
 *
 * `fingerprint` is what makes that safe. It is a cheap hash of the exact field
 * text that was graded, so an edited note falls out of the cache by itself.
 * Without it the screen would keep showing a criticism of a sentence the person
 * already rewrote — which is worse than showing nothing, because they fixed it
 * and the app did not notice.
 */

/** Spelled the same way in every deck-scoped query in the app. */
const DECK_OF = 'COALESCE(c.deck_id, n.deck_id)'

export interface DoctorCard {
  id: string
  fields: Record<string, string>
  fingerprint: string
}

export interface FlaggedCard {
  note_id: string
  deck: string
  preview: string
  tier: number
  dimension: string
  reason: string
}

/**
 * A stable, cheap hash of what was graded.
 *
 * Not a cryptographic digest: it is a cache key, it never leaves the device,
 * and a collision costs one stale verdict on one card. `crypto.subtle` would
 * make every row an async call for that.
 */
export function fingerprint(fields: Record<string, string>): string {
  const text = Object.keys(fields).sort().map((k) => `${k}=${fields[k] ?? ''}`).join('\u0000')
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < text.length; i++) {
    h1 = Math.imul(h1 ^ text.charCodeAt(i), 0x01000193)
    h2 = Math.imul(h2 + text.charCodeAt(i), 0x85ebca6b)
  }
  return ((h1 >>> 0).toString(16) + (h2 >>> 0).toString(16)).padStart(16, '0')
}

/**
 * Notes in a deck that have never been graded, or were graded before an edit.
 *
 * Returns at most one batch. The caller loops, which keeps the progress
 * honest: a sweep that says "3 of 40 batches" is one somebody can decide to
 * stop, and a single call that grades everything is a bill with no brake.
 */
export async function needsGrading(deckId: string | null, limit = GRADE_BATCH): Promise<DoctorCard[]> {
  const scope = deckId
    ? `AND ${DECK_OF} IN (
         WITH RECURSIVE sub(id) AS (
           SELECT ? UNION ALL SELECT d.id FROM decks d JOIN sub ON d.parent_id = sub.id
         ) SELECT id FROM sub)`
    : ''

  // The join to `cards` is only to reach the deck override, so one row per
  // note: a note with three cards is one prompt to judge, not three.
  const rows = await db.select<{ id: string; fields: string }>(
    `SELECT n.id, n.fields
       FROM notes n
       LEFT JOIN cards c ON c.note_id = n.id AND c.ord = 0
       LEFT JOIN note_grades g ON g.note_id = n.id
      WHERE 1 = 1 ${scope}
      GROUP BY n.id
      ORDER BY n.rowid
      LIMIT 2000`,
    deckId ? [deckId] : [],
  )

  const graded = new Map(
    (await db.select<{ note_id: string; fingerprint: string }>(
      'SELECT note_id, fingerprint FROM note_grades',
    )).map((r) => [r.note_id, r.fingerprint]),
  )

  const out: DoctorCard[] = []
  for (const row of rows) {
    const fields = JSON.parse(row.fields) as Record<string, string>
    const print = fingerprint(fields)
    if (graded.get(row.id) === print) continue
    out.push({ id: row.id, fields, fingerprint: print })
    if (out.length >= limit) break
  }
  return out
}

/** How much of this deck still has to be looked at, for the estimate. */
export async function pendingCount(deckId: string | null): Promise<number> {
  return (await needsGrading(deckId, Number.MAX_SAFE_INTEGER)).length
}

/** Store a batch of verdicts against the text they were about. */
export async function saveVerdicts(
  verdicts: AiVerdict[],
  prints: Map<string, string>,
  now = Date.now(),
): Promise<void> {
  if (!verdicts.length) return

  await db.batch(verdicts.map((v) => ({
    sql: `INSERT INTO note_grades (note_id, tier, dimension, reason, fingerprint, graded_at)
          VALUES (?,?,?,?,?,?)
          ON CONFLICT(note_id) DO UPDATE SET
            tier = excluded.tier, dimension = excluded.dimension,
            reason = excluded.reason, fingerprint = excluded.fingerprint,
            graded_at = excluded.graded_at`,
    params: [v.id, v.tier, v.dimension, v.reason, prints.get(v.id) ?? '', now],
  })))
}

/**
 * The cards worth looking at, worst first.
 *
 * Tier 3 is excluded — this screen exists to name problems, and a list that
 * includes every card that is fine is a list nobody reads to the bottom of.
 */
export async function flagged(deckId: string | null, limit = 200): Promise<FlaggedCard[]> {
  const scope = deckId
    ? `AND ${DECK_OF} IN (
         WITH RECURSIVE sub(id) AS (
           SELECT ? UNION ALL SELECT d.id FROM decks d JOIN sub ON d.parent_id = sub.id
         ) SELECT id FROM sub)`
    : ''

  const rows = await db.select<{
    note_id: string; deck: string; fields: string; nt_fields: string
    sort_field: number; tier: number; dimension: string; reason: string
  }>(
    `SELECT g.note_id, d.name AS deck, n.fields, nt.fields AS nt_fields, nt.sort_field,
            g.tier, g.dimension, g.reason
       FROM note_grades g
       JOIN notes n ON n.id = g.note_id
       LEFT JOIN cards c ON c.note_id = n.id AND c.ord = 0
       JOIN decks d ON d.id = ${DECK_OF}
       JOIN note_types nt ON nt.id = n.note_type
      WHERE g.tier < 3 ${scope}
      GROUP BY g.note_id
      ORDER BY g.tier ASC, g.graded_at DESC
      LIMIT ?`,
    deckId ? [deckId, limit] : [limit],
  )

  return rows.map((r) => {
    const fields = JSON.parse(r.fields) as Record<string, string>
    const names = JSON.parse(r.nt_fields) as string[]
    const raw = fields[names[r.sort_field] ?? names[0] ?? ''] ?? Object.values(fields)[0] ?? ''
    return {
      note_id: r.note_id,
      deck: r.deck,
      preview: raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120),
      tier: r.tier,
      dimension: r.dimension,
      reason: r.reason,
    }
  })
}

/** How the sweep has gone so far, for the summary line. */
export async function summary(deckId: string | null): Promise<{ graded: number; flagged: number }> {
  const scope = deckId
    ? `AND ${DECK_OF} IN (
         WITH RECURSIVE sub(id) AS (
           SELECT ? UNION ALL SELECT d.id FROM decks d JOIN sub ON d.parent_id = sub.id
         ) SELECT id FROM sub)`
    : ''

  const [row] = await db.select<{ graded: number; flagged: number }>(
    `SELECT COUNT(*) AS graded, SUM(g.tier < 3) AS flagged
       FROM note_grades g
       JOIN notes n ON n.id = g.note_id
       LEFT JOIN cards c ON c.note_id = n.id AND c.ord = 0
      WHERE 1 = 1 ${scope}`,
    deckId ? [deckId] : [],
  )

  return { graded: row?.graded ?? 0, flagged: row?.flagged ?? 0 }
}
