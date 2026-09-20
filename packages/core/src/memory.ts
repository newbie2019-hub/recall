import { computeDecayFactor, forgetting_curve, generatorParameters } from 'ts-fsrs'
import { applyReview, newCard } from './scheduler.ts'
import type { Card, Review } from './types.ts'

/**
 * Retrievability: the model's estimate of whether you would remember a card
 * right now, and the one quantity almost every honest metric is built on.
 *
 * FSRS's forgetting curve is a power law, not an exponential:
 *
 *     R(t, S) = (1 + FACTOR · t/S) ^ DECAY,   FACTOR = 0.9^(1/DECAY) − 1
 *
 * with `S` *defined* as the days until R falls to 0.9, so `R(S, S) = 0.9`
 * exactly. The power law matters: its hazard rate falls with time, so a memory
 * that has already survived a long gap is more durable going forward — which an
 * exponential cannot express, and which is why FSRS-4 abandoned them.
 *
 * ⚠️ **`DECAY` is not a constant.** FSRS-4.5 and 5 fixed it at −0.5; FSRS-6
 * made it a trained weight (`w20`), and this app ships stock FSRS-6 defaults,
 * so it is −0.1542 here. Every derived constant moves with it — the widely
 * quoted "half-life ≈ 12.79 × stability" is the decay-0.5 figure and is
 * **90.4 × stability** at our decay. Anything derived from the curve therefore
 * reads the live parameters rather than hard-coding a number.
 *
 * Everything below is a pure function of the review log plus FSRS state, so it
 * can be recomputed from scratch at any time — which is the whole reason the
 * log is append-only (README rule 1).
 */

/** The parameter vector the app schedules with. Retention does not affect the curve. */
const PARAMS = generatorParameters({ enable_fuzz: false }).w

const MS_PER_DAY = 86_400_000

/** Probability of recall after `elapsedDays` for a card of this stability. */
export function retrievability(stability: number, elapsedDays: number): number {
  if (!(stability > 0)) return 0
  return forgetting_curve(PARAMS, Math.max(0, elapsedDays), stability)
}

/** Same, for a card as it stands now. A never-reviewed card is not remembered. */
export function retrievabilityNow(card: Pick<Card, 'stability' | 'last_review'>, now = Date.now()): number {
  if (!card.last_review || !(card.stability > 0)) return 0
  return retrievability(card.stability, (now - card.last_review) / MS_PER_DAY)
}

/**
 * Days from a card's last review until recall drops to `target`.
 *
 * The inverse of the curve, and the honest way to say "how long will this
 * last": `daysUntil(S, 0.8)` sits inside the range the model was fit on, where
 * a half-life at our decay is two and a half years for a ten-day card — a true
 * statement about the model that reads as a lie to a person.
 */
export function daysUntil(stability: number, target: number): number {
  if (!(stability > 0) || target <= 0 || target >= 1) return 0
  const { decay, factor } = computeDecayFactor(PARAMS)
  return (stability / factor) * (target ** (1 / decay) - 1)
}

/** For the curious: the real multiplier, computed rather than quoted. */
export const halfLifeMultiplier = (): number => daysUntil(1, 0.5)

export interface PredictedReview {
  ts: number
  rating: number
  /** What the model expected *before* this answer. 0 for a card's first sight. */
  predicted: number
  /** Whether it was actually recalled. `Again` is the only failure. */
  recalled: boolean
  /** Stability going into the review, so results can be bucketed honestly. */
  stability: number
  /** Days since the previous review of this card. */
  elapsedDays: number
}

/**
 * Replay a card's log, recording what the model predicted before each answer.
 *
 * This is the piece Anki cannot do — it does not store historical
 * retrievability, and its developers cite that as the blocker on their own
 * automated-leech thread. Here the log is append-only and the scheduler is a
 * pure fold, so stopping the fold before each review reconstructs exactly what
 * FSRS believed at that moment.
 *
 * Two things it unlocks: **calibration** (did the prediction match the
 * outcome?), which is the caveat that licenses every other model-derived number
 * on the dashboard, and **an interval-adjusted leech test**, which knows the
 * difference between eight failures in eighty reviews and eight in eleven.
 *
 * Same-day reviews are kept. They are part of learning and dropping them would
 * quietly change what "a review" means between this and the rest of the app.
 */
export function replayWithRetrievability(
  card: Pick<Card, 'id' | 'note_id' | 'ord'>,
  reviews: Review[],
  retentionTarget: number,
  createdAt: number,
): { card: Card; reviews: PredictedReview[] } {
  const ordered = [...reviews].sort((a, b) => a.ts - b.ts)
  let state = newCard(card.id, card.note_id, card.ord, createdAt)
  const out: PredictedReview[] = []

  for (const r of ordered) {
    const elapsedDays = state.last_review ? (r.ts - state.last_review) / MS_PER_DAY : 0
    out.push({
      ts: r.ts,
      rating: r.rating,
      // A card being seen for the first time was never predicted, and scoring
      // it as a miss would make every new card look like a calibration failure.
      predicted: state.last_review ? retrievability(state.stability, elapsedDays) : 0,
      recalled: r.rating > 1,
      stability: state.stability,
      elapsedDays,
    })
    state = applyReview(state, r.rating as never, r.ts, retentionTarget)
  }

  return { card: state, reviews: out }
}

/**
 * How improbable this card's failures are, given what was predicted each time.
 *
 * A lapse *count* — Anki's rule, and this app's until now — is not
 * interval-adjusted, and at 90% desired retention every card is supposed to
 * fail about one time in ten. Eight lapses in eighty reviews is a card working
 * exactly as designed; eight in eleven is pathological. A count cannot tell
 * them apart, so it suspends the first and takes eight failures to notice the
 * second.
 *
 * Failures are a sum of independent Bernoulli trials with *different*
 * probabilities — a Poisson-binomial — so the right question is
 * `P(failures ≥ observed)`. The DP below is the standard O(n²) convolution:
 * `dist[k]` is the probability of exactly `k` failures across the reviews seen
 * so far.
 *
 * Returns a p-value. Small means "this card fails far more than the model
 * expects", which is what a leech actually is.
 */
export function failureSurprise(reviews: PredictedReview[]): number {
  const running = surpriseOverTime(reviews)
  return running.length ? running[running.length - 1]!.p : 1
}

/**
 * The same p-value after each review, which is what tells us *when* a card
 * became a leech rather than only that it is one.
 *
 * Computed in one pass: the distribution is convolved review by review, so the
 * whole history costs O(n²) once instead of O(n²) per prefix. The running
 * version is what stops the flag re-firing on every subsequent failure — the
 * nag that makes people turn leech detection off.
 */
export function surpriseOverTime(reviews: PredictedReview[]): { ts: number; p: number; failures: number }[] {
  // A first sight was never predicted, so it cannot be surprising.
  const scored = reviews.filter((r) => r.predicted > 0)
  const out: { ts: number; p: number; failures: number }[] = []

  let dist = [1]
  let failures = 0

  for (const review of scored) {
    const fail = Math.min(0.999, Math.max(0.001, 1 - review.predicted))
    const next = new Array<number>(dist.length + 1).fill(0)
    for (let k = 0; k < dist.length; k++) {
      next[k]! += dist[k]! * (1 - fail)
      next[k + 1]! += dist[k]! * fail
    }
    dist = next
    if (!review.recalled) failures++

    let tail = 0
    for (let k = failures; k < dist.length; k++) tail += dist[k]!
    out.push({ ts: review.ts, p: failures === 0 ? 1 : Math.min(1, Math.max(0, tail)), failures })
  }

  return out
}

/** Below this, a card fails so much more than predicted that it is a leech. */
export const LEECH_ALPHA = 0.01
