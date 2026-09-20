/**
 * Moving a card's review history when its ordinal changes.
 *
 * A card id is `<note id>:<ord>` (README rule 2), so remapping an ordinal
 * renames the card — and the answers somebody gave to it have to follow. They
 * used to be left behind, which meant a card regenerated at the old ordinal
 * silently inherited a stranger's history the next time anything replayed it.
 * `cards` is a cache of `reviews`, so that is scheduling built on the wrong
 * answers, not a cosmetic inconsistency.
 *
 * The statements are built here rather than inline in `repo.ts` because the
 * *sequence* is the subtle part and the sequence is what needs a test: ordinals
 * 0 and 1 swapping would collide halfway through a one-pass rename, exactly as
 * the card rows themselves would.
 */

export interface CardMove {
  from: string
  to: string
}

export interface SqlStatement {
  sql: string
  params: unknown[]
}

/**
 * A marker that cannot collide with a real card id.
 *
 * A card id is `<uuid>:<int>` and contains exactly one colon, so a second one
 * is unreachable by any id the app can mint.
 */
const PARKED = (id: string) => `${id}:moving`

/**
 * Two passes: park every moving row, then land them.
 *
 * One pass would be wrong for a swap. Renaming `n:0` → `n:1` while `n:1` still
 * holds its own rows merges two cards' histories into one, and the second
 * rename then moves the merged pile. Parking first makes the order irrelevant,
 * which is the same reason `changeNoteType` deletes every card row before
 * reinserting the survivors.
 *
 * Moves that do not change the id are dropped: rewriting them would mark rows
 * unsynced for no reason and cost a push.
 */
export function moveReviewStatements(moves: CardMove[]): SqlStatement[] {
  const real = moves.filter((m) => m.from !== m.to)
  if (!real.length) return []

  return [
    ...real.map((m) => ({
      sql: 'UPDATE reviews SET card_id = ? WHERE card_id = ?',
      params: [PARKED(m.from), m.from],
    })),
    // `synced = 0` so the corrected pointer reaches the server. It accepts a
    // new `card_id` for a review it already has, and only when the new id
    // belongs to the same note.
    ...real.map((m) => ({
      sql: 'UPDATE reviews SET card_id = ?, synced = 0 WHERE card_id = ?',
      params: [m.to, PARKED(m.from)],
    })),
  ]
}
