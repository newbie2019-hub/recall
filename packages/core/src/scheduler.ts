import {
  fsrs,
  generatorParameters,
  createEmptyCard,
  State,
  type Card as FsrsCard,
  type FSRS,
} from 'ts-fsrs'
import type { Card, Review, RatingValue, CardStateName } from './types.ts'

const STATE_NAMES: Record<number, CardStateName> = {
  [State.New]: 'new',
  [State.Learning]: 'learning',
  [State.Review]: 'review',
  [State.Relearning]: 'relearning',
}
const STATE_VALUES: Record<CardStateName, State> = {
  new: State.New,
  learning: State.Learning,
  review: State.Review,
  relearning: State.Relearning,
}

/**
 * ponytail: fuzz disabled so replaying the review log reproduces the exact same
 * due dates. ts-fsrs seeds its fuzz from wall-clock state, so with fuzz on,
 * replayReviews() would drift from the state it is meant to rebuild - and the
 * log is our source of truth. If same-day clumping becomes a real complaint,
 * add deterministic jitter here keyed off card.id, not ts-fsrs's fuzz.
 */
export function scheduler(retentionTarget: number): FSRS {
  return fsrs(
    generatorParameters({ request_retention: retentionTarget, enable_fuzz: false }),
  )
}

function toFsrs(card: Card): FsrsCard {
  return {
    due: new Date(card.due),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: STATE_VALUES[card.state],
    last_review: card.last_review ? new Date(card.last_review) : undefined,
  }
}

function fromFsrs(base: Card, f: FsrsCard): Card {
  return {
    ...base,
    due: f.due.getTime(),
    stability: f.stability,
    difficulty: f.difficulty,
    state: STATE_NAMES[f.state] ?? 'new',
    learning_steps: f.learning_steps,
    reps: f.reps,
    lapses: f.lapses,
    last_review: f.last_review ? f.last_review.getTime() : null,
  }
}

export function newCard(id: string, noteId: string, ord: number, now: number): Card {
  const empty = createEmptyCard(new Date(now))
  return fromFsrs(
    {
      id,
      note_id: noteId,
      ord,
      due: now,
      stability: 0,
      difficulty: 0,
      state: 'new',
      learning_steps: 0,
      reps: 0,
      lapses: 0,
      last_review: null,
      suspended: false,
      buried_until: null,
      flag: 0,
    },
    empty,
  )
}

/** Apply one rating. Pure: returns the next state, mutates nothing. */
export function applyReview(
  card: Card,
  rating: RatingValue,
  at: number,
  retentionTarget: number,
): Card {
  const f = scheduler(retentionTarget)
  const { card: next } = f.next(toFsrs(card), new Date(at), rating)
  return fromFsrs(card, next)
}

/** Preview all four outcomes, for showing intervals on the answer buttons. */
export function previewIntervals(
  card: Card,
  at: number,
  retentionTarget: number,
): Record<RatingValue, number> {
  const out = {} as Record<RatingValue, number>
  for (const r of [1, 2, 3, 4] as RatingValue[]) {
    out[r] = applyReview(card, r, at, retentionTarget).due
  }
  return out
}

/**
 * Rebuild a card's scheduling state from its review log.
 *
 * This is the function that makes the append-only log the source of truth:
 * `cards` is a derived cache and can always be thrown away and recomputed.
 * Sync correctness, history import and FSRS re-optimisation all lean on it.
 */
export function replayReviews(
  card: Pick<Card, 'id' | 'note_id' | 'ord'>,
  reviews: Review[],
  retentionTarget: number,
  createdAt: number,
): Card {
  const ordered = [...reviews].sort((a, b) => a.ts - b.ts)
  let state = newCard(card.id, card.note_id, card.ord, createdAt)
  for (const r of ordered) state = applyReview(state, r.rating, r.ts, retentionTarget)
  return state
}
