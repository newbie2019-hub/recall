/**
 * Sibling burying — the most-noticed missing behaviour on reversed decks.
 *
 * Answer "heart → cor" and the reverse card is still due an hour later, so you
 * answer a question you have just been shown the answer to and FSRS records a
 * confident pass that is really a memory of the last two minutes. Anki hides a
 * note's other cards until tomorrow; this is that rule, as a pure function.
 *
 * Rule 2 is what makes it cheap: card ids are `<note id>:<ord>`, so a card's
 * siblings are the rows sharing its note id — no join, no lookup table, and the
 * same answer on web and on RN.
 */
import type { CardStateName } from './types.ts'

export const noteIdOf = (cardId: string): string => {
  const i = cardId.lastIndexOf(':')
  return i < 0 ? cardId : cardId.slice(0, i)
}

export const ordOf = (cardId: string): number => {
  const i = cardId.lastIndexOf(':')
  return i < 0 ? 0 : Number(cardId.slice(i + 1))
}

export const areSiblings = (a: string, b: string): boolean =>
  a !== b && noteIdOf(a) === noteIdOf(b)

export interface BuryOptions {
  /** Hide the note's unseen cards too. Off means a new sibling can still appear. */
  newCards: boolean
  reviews: boolean
}

export const DEFAULT_BURY: BuryOptions = { newCards: true, reviews: true }

export interface SiblingCard {
  id: string
  state: CardStateName
  suspended: boolean
  buried_until: number | null
}

/**
 * Local midnight *after* `now`.
 *
 * `setDate(+1)` then `setHours(0)`, not midnight + 86,400,000: on the two DST
 * days a year the latter lands at 23:00 or 01:00, which either un-buries a card
 * an hour early or holds it an hour into the next day.
 */
export function nextDayStart(now: number): number {
  const d = new Date(now)
  d.setDate(d.getDate() + 1)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Which of a note's cards to hide after one of them was answered.
 *
 * Suspended cards are left alone — a suspension is a decision the user made and
 * burying would quietly outlive it. A card already buried *further out* keeps
 * its later date, so a manual bury is never shortened by answering a sibling.
 */
export function siblingsToBury(
  answeredId: string,
  noteCards: SiblingCard[],
  until: number,
  options: Partial<BuryOptions> = {},
): string[] {
  const opts = { ...DEFAULT_BURY, ...options }
  return noteCards
    .filter(
      (c) =>
        c.id !== answeredId &&
        noteIdOf(c.id) === noteIdOf(answeredId) &&
        !c.suspended &&
        (c.buried_until === null || c.buried_until < until) &&
        (c.state === 'new' ? opts.newCards : opts.reviews),
    )
    .map((c) => c.id)
}
