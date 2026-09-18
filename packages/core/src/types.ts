/** Domain types shared by web and (later) React Native. No DOM, no React. */

export type CardStateName = 'new' | 'learning' | 'review' | 'relearning'

/** 1-4, matching the four answer buttons. Mirrors ts-fsrs Rating. */
export const Rating = { Again: 1, Hard: 2, Good: 3, Easy: 4 } as const
export type RatingValue = (typeof Rating)[keyof typeof Rating]

export interface Deck {
  id: string
  parent_id: string | null
  name: string
  retention_target: number
  new_per_day: number
}

export interface Note {
  id: string
  note_type: string
  deck_id: string
  /** Field name -> value. Rendered by the template engine in Phase 2. */
  fields: Record<string, string>
  tags: string[]
  /** Foundational Model of Anatomy concept id. Null for non-anatomy cards. */
  fma_id: string | null
  updated_at: number
}

/** Scheduling state. Derived from the review log - never the only copy. */
export interface Card {
  id: string
  note_id: string
  /** Which template of the note type produced this card. */
  ord: number
  due: number
  stability: number
  difficulty: number
  state: CardStateName
  /** ts-fsrs v5 tracks position within the learning/relearning steps here. */
  learning_steps: number
  reps: number
  lapses: number
  last_review: number | null
  /** Excluded from study until unsuspended. */
  suspended: boolean
  /** Hidden until this timestamp (sibling burying). */
  buried_until: number | null
  flag: number
}

/** Append-only. Never UPDATE, never DELETE. */
export interface Review {
  id: string
  card_id: string
  ts: number
  rating: RatingValue
  duration_ms: number
}
