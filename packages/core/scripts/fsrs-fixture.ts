/**
 * Generate the cross-implementation fixture for the PHP scheduler.
 *
 * The server replays the same review log the client does, and the only honest
 * way to know two implementations of FSRS agree is to pin one against the
 * other. This writes what `ts-fsrs` produces, step by step, for sequences that
 * cover every transition the state machine has: the learning steps, a lapse
 * into relearning, same-day repeats, a card left months overdue, and Easy from
 * new (which skips the steps entirely).
 *
 * Run it when `ts-fsrs` is upgraded. A diff in the fixture is the upgrade's
 * real changelog, and a PHP suite going red against a regenerated fixture is
 * the port asking to be updated rather than a mystery.
 *
 *   pnpm --filter @recall/core fixture
 */
import { writeFileSync } from 'node:fs'
import { applyReview, newCard } from '../src/scheduler.ts'
import type { Card, RatingValue } from '../src/types.ts'

const DAY = 86_400_000
const MIN = 60_000
const T0 = Date.parse('2026-01-01T09:00:00.000Z')

interface Step {
  /** Milliseconds after the card was created. */
  at: number
  rating: RatingValue
  retention: number
  after: Pick<Card, 'due' | 'stability' | 'difficulty' | 'state' | 'learning_steps' | 'reps' | 'lapses' | 'last_review'>
}

interface Case {
  name: string
  created_at: number
  steps: Step[]
}

/** `[offset from creation, rating, retention target]` */
type Move = [number, RatingValue, number?]

const CASES: { name: string; moves: Move[] }[] = [
  {
    name: 'the ordinary path: learning steps, then review',
    moves: [[0, 3], [1 * MIN, 3], [10 * MIN, 3], [1 * DAY + 10 * MIN, 3], [15 * DAY, 3]],
  },
  {
    name: 'Easy from new skips the steps',
    moves: [[0, 4], [5 * DAY, 4], [40 * DAY, 3]],
  },
  {
    name: 'Again on a new card repeats the first step',
    moves: [[0, 1], [1 * MIN, 1], [2 * MIN, 3], [12 * MIN, 3]],
  },
  {
    name: 'Hard everywhere',
    moves: [[0, 2], [5 * MIN, 2], [20 * MIN, 2], [2 * DAY, 2], [4 * DAY, 2]],
  },
  {
    name: 'a lapse drops into relearning and comes back',
    moves: [[0, 3], [10 * MIN, 3], [3 * DAY, 3], [20 * DAY, 1], [10 * MIN + 20 * DAY, 3], [30 * DAY, 3]],
  },
  {
    name: 'two lapses in a row',
    moves: [[0, 3], [10 * MIN, 3], [5 * DAY, 1], [5 * DAY + 10 * MIN, 1], [5 * DAY + 20 * MIN, 3], [25 * DAY, 3]],
  },
  {
    name: 'a card left six months overdue',
    moves: [[0, 3], [10 * MIN, 3], [2 * DAY, 3], [180 * DAY, 3], [400 * DAY, 3]],
  },
  {
    name: 'same-day repeats after a success',
    moves: [[0, 3], [10 * MIN, 3], [2 * DAY, 3], [2 * DAY + 60 * MIN, 3], [2 * DAY + 120 * MIN, 4]],
  },
  {
    name: 'the retention target moves mid-history',
    moves: [[0, 3, 0.9], [10 * MIN, 3, 0.9], [2 * DAY, 3, 0.8], [30 * DAY, 3, 0.95], [40 * DAY, 3, 0.7]],
  },
  {
    name: 'a long correct run, to exercise stability growth',
    moves: [[0, 3], [10 * MIN, 3], [2 * DAY, 3], [12 * DAY, 3], [45 * DAY, 3], [150 * DAY, 3], [500 * DAY, 3]],
  },
]

const cases: Case[] = CASES.map(({ name, moves }) => {
  let card = newCard('n:0', 'n', 0, T0)
  const steps: Step[] = []

  for (const [offset, rating, retention = 0.9] of moves) {
    const at = T0 + offset
    card = applyReview(card, rating, at, retention)
    steps.push({
      at: offset,
      rating,
      retention,
      after: {
        due: card.due - T0,
        stability: card.stability,
        difficulty: card.difficulty,
        state: card.state,
        learning_steps: card.learning_steps,
        reps: card.reps,
        lapses: card.lapses,
        last_review: card.last_review === null ? null : card.last_review - T0,
      },
    })
  }

  return { name, created_at: 0, steps }
})

const out = {
  // Everything a second implementation needs to reproduce this, so a fixture
  // that disagrees can be told apart from a parameter that changed.
  generated_by: 'packages/core/scripts/fsrs-fixture.ts',
  note: 'Offsets are milliseconds from the card\'s creation. Regenerate when ts-fsrs changes.',
  cases,
}

const path = new URL('../../../apps/api/tests/Fixtures/fsrs.json', import.meta.url).pathname
writeFileSync(path, JSON.stringify(out, null, 2) + '\n')
console.log(`wrote ${cases.length} cases, ${cases.reduce((n, c) => n + c.steps.length, 0)} steps → ${path}`)
