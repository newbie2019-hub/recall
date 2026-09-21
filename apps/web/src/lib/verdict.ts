/**
 * How a grader's verdict reads on screen.
 *
 * Shared by the card doctor (a sweep over cards that exist) and the critic in
 * the note editor (one card being written), because they are the same rubric
 * and a card that is "weak" in one place must not be "needs work" in the
 * other. The tiers and dimensions are the Memory Machines benchmark's, carried
 * through `GradeService` unchanged.
 */

/**
 * Tier 1 is the one that matters and the one the colour is spent on: the card
 * that looks fine and is not. Tier 0 is rarer and self-evident once you read it.
 */
export const TIER: Record<number, { label: string; className: string }> = {
  0: { label: 'broken', className: 'text-eosin' },
  1: { label: 'weak', className: 'text-eosin' },
  2: { label: 'fixable', className: 'text-muted-foreground' },
  // Never rendered by the doctor — a list of everything that is fine is one
  // nobody reads to the bottom of — but the editor says so out loud, because
  // there the question was asked about one card and deserves an answer.
  3: { label: 'holds up', className: 'text-muted-foreground' },
}

/** A fallback sentence when the model returned a dimension and no prose. */
export const DIMENSION: Record<string, string> = {
  lacks_context: 'Ambiguous on its own — it could be asked of several things.',
  multiple_answers: 'More than one answer is correct, so a right one can read as wrong.',
  shallow: 'The question cues its own answer.',
  wordy: 'Long enough that you will read it rather than recall it.',
  too_narrow: 'A fragment with no standalone meaning.',
}
