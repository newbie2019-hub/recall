/**
 * Rebuilding the derived card cache from the append-only log.
 *
 * Its own module because three callers need it and they must not disagree:
 * the sync pull (reviews arrived), the browser (an override was written) and
 * anything else that later changes what a card's history is. Two copies of
 * this loop would be two chances to differ about what an override means.
 */
import { db } from '../client.ts'
import { replayReviews, type Review } from '@recall/core'

const UPDATE_CARD = `UPDATE cards SET due=?, stability=?, difficulty=?, state=?,
  learning_steps=?, reps=?, lapses=?, last_review=? WHERE id=?`

const chunked = <T>(xs: T[], size = 400): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size))
  return out
}

const holes = (n: number) => Array.from({ length: n }, () => '?').join(',')

/**
 * Rebuild the cache for cards whose history or overrides just changed.
 *
 * A card with no row is skipped rather than created: the note that generates it
 * has not been pulled yet, and `saveNote` replays the log into it the moment it
 * arrives.
 */
export async function replayCards(cardIds: string[]): Promise<void> {
  for (const ids of chunked(cardIds)) {
    const meta = await db.select<{
      id: string; note_id: string; ord: number; retention_target: number
      created_at: number; due_override: number | null; forgotten_at: number | null
    }>(
      `SELECT c.id, c.note_id, c.ord, c.created_at, c.due_override, c.forgotten_at,
              d.retention_target
         FROM cards c
         JOIN notes n ON n.id = c.note_id
         JOIN decks d ON d.id = COALESCE(c.deck_id, n.deck_id)
        WHERE c.id IN (${holes(ids.length)})`, ids,
    )
    if (!meta.length) continue
    const log = await db.select<Review>(
      `SELECT * FROM reviews WHERE card_id IN (${holes(ids.length)}) ORDER BY ts`, ids,
    )
    await db.batch(meta.map((m) => {
      const own = log.filter((r) => r.card_id === m.id)
      // The overrides are read from the row rather than passed in, because the
      // reviews and the override can arrive in either order — a forget pulled
      // before the answers it forgets still has to win.
      const card = replayReviews(
        { id: m.id, note_id: m.note_id, ord: m.ord },
        own, m.retention_target, m.created_at || own[0]?.ts || Date.now(),
        { due_override: m.due_override, forgotten_at: m.forgotten_at },
      )
      return {
        sql: UPDATE_CARD,
        params: [card.due, card.stability, card.difficulty, card.state,
                 card.learning_steps, card.reps, card.lapses, card.last_review, card.id],
      }
    }))
  }
}
