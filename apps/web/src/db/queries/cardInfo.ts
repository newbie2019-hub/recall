/**
 * Everything known about one card, for the dialog that shows its history.
 *
 * Anki has had this screen forever and it is the first thing anyone opens when
 * a card feels wrong. Ours can answer one question Anki's cannot: **what did
 * the scheduler expect, each time you answered?** The log is append-only and
 * `applyReview` is a pure fold, so truncating the replay before each review
 * reconstructs exactly what FSRS believed at that moment — which is what turns
 * "you failed this five times" into "you failed it five times when the model
 * was confident, and that is the surprising part".
 *
 * Everything here is derived. Nothing in this module writes.
 */
import { db } from '../client.ts'
import {
  DECK_OF, replayWithRetrievability, retrievabilityNow,
  type PredictedReview, type Review,
} from '@recall/core'

const DAY = 86_400_000

export interface CardFact {
  id: string
  note_id: string
  ord: number
  template: string
  note_type: string
  deck_name: string
  state: string
  due: number
  stability: number
  difficulty: number
  reps: number
  lapses: number
  last_review: number | null
  suspended: boolean
  buried_until: number | null
  flag: number
  created_at: number
  /** Set when somebody picked this card's next date rather than FSRS. */
  due_override: number | null
  /** Set when somebody reset the card; reviews at or before it are not its own. */
  forgotten_at: number | null
  /** The model's estimate that you would remember it right now. */
  retrievability: number
  /** Days the current interval covers — the gap FSRS actually chose. */
  interval_days: number
}

export interface CardInfo {
  card: CardFact
  /** Oldest first, each carrying what the model predicted beforehand. */
  reviews: (PredictedReview & { duration_ms: number; imported: boolean })[]
  /** Total seconds answered, and the median — never the mean. */
  total_ms: number
  median_ms: number
}

/**
 * One card, its note type, its deck and its whole log.
 *
 * Returns `null` rather than throwing for a card that has gone: the dialog can
 * outlive the row behind it, because deleting the note is one of the things you
 * can do while it is open.
 */
export async function cardInfo(cardId: string, now = Date.now()): Promise<CardInfo | null> {
  const [row] = await db.select<{
    id: string; note_id: string; ord: number; state: string; due: number
    stability: number; difficulty: number; reps: number; lapses: number
    last_review: number | null; suspended: number; buried_until: number | null
    flag: number; created_at: number
    due_override: number | null; forgotten_at: number | null
    deck_name: string; note_type: string; templates: string; retention_target: number
  }>(
    `SELECT c.id, c.note_id, c.ord, c.state, c.due, c.stability, c.difficulty,
            c.reps, c.lapses, c.last_review, c.suspended, c.buried_until, c.flag,
            c.created_at, c.due_override, c.forgotten_at,
            d.name AS deck_name, d.retention_target,
            nt.name AS note_type, nt.templates
       FROM cards c
       JOIN notes n      ON n.id = c.note_id
       JOIN decks d      ON d.id = ${DECK_OF}
       JOIN note_types nt ON nt.id = n.note_type
      WHERE c.id = ?`,
    [cardId],
  )
  if (!row) return null

  const log = await db.select<Review & { imported: number }>(
    `SELECT * FROM reviews WHERE card_id = ? ORDER BY ts`, [cardId],
  )

  // The replay is for the *history*, so it deliberately ignores the overrides:
  // a forget does not mean those answers never happened, and this screen is the
  // one place that difference is worth showing. The card's current state is
  // read from the row, which the override has already been applied to.
  const { reviews } = replayWithRetrievability(
    { id: row.id, note_id: row.note_id, ord: row.ord },
    log, row.retention_target, row.created_at || log[0]?.ts || now,
  )

  const times = log.map((r) => r.duration_ms).filter((ms) => ms > 0).sort((a, b) => a - b)

  return {
    card: {
      ...row,
      suspended: !!row.suspended,
      template: templateName(row.templates, row.ord),
      retrievability: retrievabilityNow(row, now),
      interval_days: row.last_review ? (row.due - row.last_review) / DAY : 0,
    },
    reviews: reviews.map((r, i) => ({
      ...r,
      duration_ms: log[i]?.duration_ms ?? 0,
      imported: !!log[i]?.imported,
    })),
    total_ms: times.reduce((s, ms) => s + ms, 0),
    // The median, because one card left open over lunch drags a mean and this
    // screen exists to be trusted about exactly that kind of card.
    median_ms: times.length ? times[times.length >> 1]! : 0,
  }
}

/** The template that made this card, or its ordinal if the type has changed. */
function templateName(raw: string, ord: number): string {
  try {
    const templates = JSON.parse(raw) as { name?: string }[]
    return templates[ord]?.name ?? `Card ${ord + 1}`
  } catch {
    return `Card ${ord + 1}`
  }
}
