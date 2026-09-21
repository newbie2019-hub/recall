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
 * Two scheduling decisions that are the person's rather than the model's.
 *
 * They are corrections layered on top of the log, never edits to it: the log
 * stays append-only, and a card whose overrides are cleared returns to exactly
 * the state its history implies.
 */
export interface SchedulingOverride {
  /**
   * "Forget this card": reviews at or before this instant stop being its
   * history. The log keeps them — they are still true, and true-retention and
   * any future FSRS optimisation still want them — but this card's scheduling
   * no longer descends from them.
   */
  forgotten_at?: number | null
  /**
   * A due date somebody chose. It outranks the date the log implies, and it is
   * the last thing applied, so nothing downstream can quietly recompute it.
   */
  due_override?: number | null
}

/**
 * Rebuild a card's scheduling state from its review log.
 *
 * This is the function that makes the append-only log the source of truth:
 * `cards` is a derived cache and can always be thrown away and recomputed.
 * Sync correctness, history import and FSRS re-optimisation all lean on it.
 *
 * `override` is applied around the fold rather than inside it, which is what
 * keeps both halves honest: a forget moves where the replay *starts*, so the
 * card genuinely relearns rather than being a mature card wearing a new date,
 * and a chosen due date is stamped *after* FSRS has had its say, so it cannot
 * be half-overwritten by the next thing that reads the card.
 */
export function replayReviews(
  card: Pick<Card, 'id' | 'note_id' | 'ord'>,
  reviews: Review[],
  retentionTarget: number,
  createdAt: number,
  override: SchedulingOverride = {},
): Card {
  const forgotten = override.forgotten_at ?? null
  const ordered = [...reviews]
    .filter((r) => forgotten === null || r.ts > forgotten)
    .sort((a, b) => a.ts - b.ts)

  // A forgotten card was born again when it was forgotten. Starting it at its
  // original creation date would hand FSRS a brand-new card whose first
  // interval is measured from months ago.
  let state = newCard(card.id, card.note_id, card.ord, Math.max(createdAt, forgotten ?? 0))
  for (const r of ordered) state = applyReview(state, r.rating, r.ts, retentionTarget)

  // Last word, and only on the date. Stability and difficulty are what the
  // model learned from real answers; a person picking when to see a card next
  // is not a claim about how well they know it.
  return override.due_override != null ? { ...state, due: override.due_override } : state
}
