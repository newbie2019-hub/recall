/**
 * The review log following its card.
 *
 * Run against a real SQLite, because what is being checked is what the
 * statements do to rows — and the case that matters is the one a one-pass
 * rename gets wrong: two ordinals swapping.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { moveReviewStatements } from './cardmove.ts'

function withReviews(rows: [string, string][]) {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE reviews (
    id TEXT PRIMARY KEY, card_id TEXT NOT NULL, ts INTEGER NOT NULL,
    rating INTEGER NOT NULL, duration_ms INTEGER NOT NULL DEFAULT 0,
    synced INTEGER NOT NULL DEFAULT 1)`)
  for (const [id, cardId] of rows) {
    db.prepare('INSERT INTO reviews (id, card_id, ts, rating) VALUES (?,?,?,?)').run(id, cardId, 1, 3)
  }
  return db
}

const run = (db: DatabaseSync, moves: { from: string; to: string }[]) => {
  for (const { sql, params } of moveReviewStatements(moves)) {
    db.prepare(sql).run(...(params as never[]))
  }
}

const cardOf = (db: DatabaseSync, id: string) =>
  (db.prepare('SELECT card_id FROM reviews WHERE id = ?').get(id) as { card_id: string }).card_id

test('a moved card takes its history with it', () => {
  const db = withReviews([['r1', 'n:0'], ['r2', 'n:0']])
  run(db, [{ from: 'n:0', to: 'n:1' }])

  assert.equal(cardOf(db, 'r1'), 'n:1')
  assert.equal(cardOf(db, 'r2'), 'n:1')
})

test('two ordinals swapping do not merge into one pile', () => {
  // The whole reason for two passes. A one-pass rename of n:0 → n:1 lands on
  // rows n:1 still holds, and the second rename then moves the merged pile —
  // which is one card inheriting another's entire history.
  const db = withReviews([['a', 'n:0'], ['b', 'n:1']])
  run(db, [{ from: 'n:0', to: 'n:1' }, { from: 'n:1', to: 'n:0' }])

  assert.equal(cardOf(db, 'a'), 'n:1', 'the first card went to the second ordinal')
  assert.equal(cardOf(db, 'b'), 'n:0', 'and the second came back the other way')
})

test('a three-way rotation also survives', () => {
  const db = withReviews([['a', 'n:0'], ['b', 'n:1'], ['c', 'n:2']])
  run(db, [
    { from: 'n:0', to: 'n:1' },
    { from: 'n:1', to: 'n:2' },
    { from: 'n:2', to: 'n:0' },
  ])

  assert.equal(cardOf(db, 'a'), 'n:1')
  assert.equal(cardOf(db, 'b'), 'n:2')
  assert.equal(cardOf(db, 'c'), 'n:0')
})

test('a card that stays where it is costs nothing', () => {
  // Rewriting it would mark the rows unsynced and buy a push for no change.
  assert.deepEqual(moveReviewStatements([{ from: 'n:0', to: 'n:0' }]), [])
  assert.deepEqual(moveReviewStatements([]), [])
})

test('moved rows are marked unsynced so the server hears about it', () => {
  const db = withReviews([['r1', 'n:0']])
  run(db, [{ from: 'n:0', to: 'n:1' }])

  const row = db.prepare('SELECT synced FROM reviews WHERE id = ?').get('r1') as { synced: number }
  assert.equal(row.synced, 0)
})

test('another note is untouched', () => {
  const db = withReviews([['mine', 'n:0'], ['theirs', 'm:0']])
  run(db, [{ from: 'n:0', to: 'n:1' }])

  assert.equal(cardOf(db, 'theirs'), 'm:0')
})

test('nothing is deleted and no outcome changes', () => {
  // The append-only rule survives this: a pointer moves, a rating never does.
  const db = withReviews([['r1', 'n:0'], ['r2', 'n:1']])
  run(db, [{ from: 'n:0', to: 'n:1' }, { from: 'n:1', to: 'n:0' }])

  // Mapped into plain objects: `node:sqlite` hands back null-prototype rows,
  // which `deepEqual` refuses against an object literal for reasons that have
  // nothing to do with what is being asserted.
  const rows = (db.prepare('SELECT id, rating FROM reviews ORDER BY id').all() as { id: string; rating: number }[])
    .map((r) => ({ id: r.id, rating: r.rating }))
  assert.deepEqual(rows, [{ id: 'r1', rating: 3 }, { id: 'r2', rating: 3 }])
})
