/**
 * Leech detection — and the part Anki leaves out: *why*.
 *
 * Anki tells you a card is a leech and stops. "8 lapses" is a symptom with no
 * action attached, so the tag gets ignored and the card keeps costing reviews.
 * Every verdict here carries a reason computed from the review log, because the
 * remedy differs completely: a card confused with its own sibling needs
 * rewriting, a card that only fails past three weeks needs a lower retention
 * target, and a card you answer in 1.8s needs you to stop guessing.
 *
 * Pure, and deliberately so: the web dashboard and the RN app both call it, and
 * neither passes a database handle.
 */
import type { Card, Review } from './types.ts'

export const LEECH_TAG = 'leech'

const DAY = 86_400_000
/** Two answers closer together than this are one session, not two tests. */
const MATURE = 21 * DAY

export type LeechAction = 'suspend' | 'flag'

export interface LeechOptions {
  /** Failed recall tests before a card is called a leech. Anki's default. */
  threshold: number
  action: LeechAction
  /** Flag written when `action` is 'flag'. 1 is the red flag in the UI. */
  flag: number
}

export const DEFAULT_LEECH: LeechOptions = { threshold: 8, action: 'suspend', flag: 1 }

export type LeechReasonCode =
  | 'confused-with-sibling'
  | 'answered-too-fast'
  | 'never-retained'
  | 'fails-after-gaps'
  | 'repeated-lapses'

export interface LeechReason {
  code: LeechReasonCode
  /** One sentence, already phrased for the dashboard. */
  text: string
  /** The sibling card this one collides with, when that is the reason. */
  sibling?: string
}

export interface LeechVerdict {
  leech: boolean
  /**
   * True only on a firing count — the threshold itself, then every half
   * threshold after. Anki does this so an unsuspended leech is not re-suspended
   * on its very next failure, and the nag is what makes people disable the
   * feature entirely.
   */
  fires: boolean
  /** Counted from the log, not from `cards.lapses` — the log is the truth. */
  lapses: number
  reason: LeechReason | null
  tag: typeof LEECH_TAG | null
  suspend: boolean
  flag: number | null
}

/** A review with the gap that preceded it. `gap` is null for a card's first. */
interface Test {
  ts: number
  rating: number
  duration_ms: number
  gap: number
}

/**
 * The reviews that were real recall tests.
 *
 * A relearning step ten minutes after a failure is not a test of memory, and
 * counting it would report a retention figure of roughly "however many learning
 * steps are configured". One day is the same boundary Anki's true-retention
 * table uses, and `db/queries/stats.ts` mirrors this rule in SQL — change one
 * and the dashboard stops agreeing with the leech list.
 */
export function recallTests(history: Review[]): Test[] {
  const sorted = [...history].sort((a, b) => a.ts - b.ts)
  const out: Test[] = []
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i]!.ts - sorted[i - 1]!.ts
    if (gap >= DAY)
      out.push({ ts: sorted[i]!.ts, rating: sorted[i]!.rating, duration_ms: sorted[i]!.duration_ms, gap })
  }
  return out
}

const median = (xs: number[]): number =>
  xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1]! : 0

const days = (ms: number) => Math.round(ms / DAY)
const secs = (ms: number) => (ms / 1000).toFixed(1)

export function detectLeech(
  card: Pick<Card, 'id' | 'ord'>,
  history: Review[],
  siblings: { id: string; ord: number; history: Review[] }[] = [],
  options: Partial<LeechOptions> = {},
): LeechVerdict {
  const opts = { ...DEFAULT_LEECH, ...options }
  const tests = recallTests(history)
  const failed = tests.filter((t) => t.rating === 1)
  const passed = tests.filter((t) => t.rating > 1)
  const lapses = failed.length

  const step = Math.max(1, Math.ceil(opts.threshold / 2))
  const leech = lapses >= opts.threshold
  const fires = leech && (lapses - opts.threshold) % step === 0

  if (!leech)
    return { leech: false, fires: false, lapses, reason: null, tag: null, suspend: false, flag: null }

  return {
    leech: true,
    fires,
    lapses,
    reason: reasonFor(card, tests, failed, passed, siblings, opts),
    tag: LEECH_TAG,
    suspend: opts.action === 'suspend',
    flag: opts.action === 'flag' ? opts.flag : null,
  }
}

function reasonFor(
  card: Pick<Card, 'id' | 'ord'>,
  tests: Test[],
  failed: Test[],
  passed: Test[],
  siblings: { id: string; ord: number; history: Review[] }[],
  opts: LeechOptions,
): LeechReason {
  // The headline case, and the one only a sibling-aware tool can see: the note
  // is not learned in *either* direction, so rewriting the prompt beats
  // grinding the card. Survives sibling burying, which co-occurrence in the
  // same session would not — burying is exactly what stops them meeting.
  const worst = siblings
    .map((s) => ({ ...s, fails: recallTests(s.history).filter((t) => t.rating === 1).length }))
    .sort((a, b) => b.fails - a.fails)[0]
  if (worst && worst.fails >= 3 && worst.fails * 2 >= failed.length)
    return {
      code: 'confused-with-sibling',
      sibling: worst.id,
      text: `${failed.length} lapses — card ${worst.ord + 1} of the same note has ${worst.fails}, so the note is not learned in either direction. Rewrite the prompt rather than grinding it.`,
    }

  // Nothing else on this list is fixable while the answer arrives before recall
  // does, so it outranks the memory explanations.
  const fastMs = median(failed.map((t) => t.duration_ms))
  const slowMs = median(passed.map((t) => t.duration_ms))
  if (failed.length >= 3 && fastMs > 0 && fastMs < 5000 && fastMs * 2 < slowMs)
    return {
      code: 'answered-too-fast',
      text: `You answer it in ${secs(fastMs)}s when you fail and ${secs(slowMs)}s when you pass — you are rating before you have recalled.`,
    }

  const failGap = median(failed.map((t) => t.gap))
  if (failGap <= 3 * DAY)
    return {
      code: 'never-retained',
      text: `It fails at a ${days(failGap) || 1}-day gap, not a long one. That is an ambiguous or overloaded card, not a hard fact — split it.`,
    }

  const mature = tests.filter((t) => t.gap >= MATURE)
  if (failGap >= 14 * DAY)
    return {
      code: 'fails-after-gaps',
      text: `It holds for a week and dies around day ${days(failGap)} (${mature.filter((t) => t.rating === 1).length}/${mature.length} failed past three weeks). Raise this deck's retention target instead of relearning it.`,
    }

  return {
    code: 'repeated-lapses',
    text: `${failed.length} lapses across ${tests.length} recall tests, with no pattern in the timing — ${opts.threshold} was the threshold.`,
  }
}
