import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS } from './schema.ts'
import {
  DEFAULT_FILTER,
  borrowStmt,
  matchSql,
  parseFilterConfig,
  returnCardStmt,
  returnDeckStmt,
  returnStrandedStmt,
  type FilterConfig,
  type Stmt,
} from './filtered.ts'

/**
 * The real migrations in an in-memory SQLite, so these are the statements the
 * app runs, not a model of them. `node:sqlite` is stdlib — no new dependency,
 * and the web app's own worker runs the same SQL through sqlite-wasm.
 */
const NOW = Date.UTC(2026, 8, 19)
const DAY = 86_400_000

function collection() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  for (const m of MIGRATIONS) db.exec(m)

  db.exec(`
    INSERT INTO decks (id, parent_id, name) VALUES ('home', NULL, 'Anatomy'), ('other', NULL, 'Pharm');
    INSERT INTO decks (id, parent_id, name, filtered, filter_config)
      VALUES ('cram', NULL, 'Exam cram', 1, '{}');
    INSERT INTO notes (id, note_type, deck_id, fields, tags, guid, updated_at)
      VALUES ('n1', 'basic', 'home', '{"Front":"a"}', ' exam ', 'g1', 0),
             ('n2', 'basic', 'home', '{"Front":"b"}', ' exam ', 'g2', 0),
             ('n3', 'basic', 'home', '{"Front":"c"}', ' other ', 'g3', 0);
  `)
  // Three cards: one overdue, one due next week, one that lives in a deck its
  // note does not (a template override — the case that loses data if `empty`
  // restores NULL instead of the home it actually had).
  card(db, 'n1:0', 'n1', NOW - DAY, 'review', null)
  card(db, 'n2:0', 'n2', NOW + 7 * DAY, 'review', null)
  card(db, 'n3:0', 'n3', NOW - DAY, 'review', 'other')
  return db
}

function card(db: DatabaseSync, id: string, note: string, due: number, state: string, deck: string | null) {
  db.prepare(
    `INSERT INTO cards (id, note_id, ord, due, state, deck_id, reps) VALUES (?,?,0,?,?,?,1)`,
  ).run(id, note, due, state, deck)
}

const run = (db: DatabaseSync, s: Stmt) => db.prepare(s.sql).run(...(s.params as never[]))
const rows = (db: DatabaseSync, sql: string) =>
  db.prepare(sql).all() as Record<string, string | number | null>[]
const homes = (db: DatabaseSync) =>
  rows(db, 'SELECT id, deck_id, original_deck_id, due FROM cards ORDER BY id')

const cfg = (over: Partial<FilterConfig> = {}): FilterConfig => ({ ...DEFAULT_FILTER, ...over })

const build = (db: DatabaseSync, c: FilterConfig, deck = 'cram') =>
  run(db, borrowStmt(deck, c, NOW))

test('build borrows the matching cards and records where each one goes home', () => {
  const db = collection()
  const before = homes(db)
  build(db, cfg({ search: 'tag:exam' }))

  const after = homes(db)
  assert.deepEqual(
    after.filter((r) => r.deck_id === 'cram').map((r) => r.id),
    ['n1:0', 'n2:0'],
  )
  // Home recorded for both, and the not-yet-due card was pulled forward so the
  // study loop will actually hand it over.
  assert.equal(after.find((r) => r.id === 'n2:0')!.original_deck_id, 'home')
  assert.equal(after.find((r) => r.id === 'n2:0')!.due, NOW)
  assert.equal(after.find((r) => r.id === 'n1:0')!.due, before.find((r) => r.id === 'n1:0')!.due)
  assert.equal(after.find((r) => r.id === 'n3:0')!.deck_id, 'other', 'unmatched card untouched')
})

test('empty is total, and puts a template override back where it was', () => {
  const db = collection()
  const before = homes(db).map((r) => `${r.id}@${r.deck_id}`)

  build(db, cfg({ search: '' })) // everything, override card included
  assert.equal(rows(db, `SELECT id FROM cards WHERE deck_id = 'cram'`).length, 3)

  run(db, returnDeckStmt('cram', NOW))
  assert.deepEqual(homes(db).map((r) => `${r.id}@${r.deck_id}`), before)
  assert.equal(rows(db, 'SELECT id FROM cards WHERE original_deck_id IS NOT NULL').length, 0)
})

test('a card can be in at most one filtered deck', () => {
  const db = collection()
  db.exec(`INSERT INTO decks (id, parent_id, name, filtered) VALUES ('cram2', NULL, 'Second', 1)`)
  build(db, cfg({ search: 'tag:exam' }))
  build(db, cfg({ search: 'tag:exam' }), 'cram2')

  assert.equal(rows(db, `SELECT id FROM cards WHERE deck_id = 'cram2'`).length, 0)
  assert.equal(rows(db, `SELECT id FROM cards WHERE deck_id = 'cram'`).length, 2)
})

test('an interrupted build strands nothing — every borrowed card still has a home', () => {
  const db = collection()
  const before = homes(db).map((r) => `${r.id}@${r.deck_id}`)

  // A build is one UPDATE, so "interrupted" is the transaction rolling back
  // half way. Whatever survives, the invariant has to hold.
  db.exec('BEGIN')
  build(db, cfg({ search: 'tag:exam' }))
  db.exec('ROLLBACK')
  assert.deepEqual(homes(db).map((r) => `${r.id}@${r.deck_id}`), before)

  // And the other half: a build that landed but whose *rebuild* never got to
  // run. Building again over the top must not take a card twice or lose a home.
  build(db, cfg({ search: 'tag:exam' }))
  build(db, cfg({ search: 'tag:exam' }))
  assert.equal(
    rows(db, `SELECT id FROM cards WHERE deck_id = 'cram' AND original_deck_id IS NULL`).length,
    0,
  )
  run(db, returnDeckStmt('cram', NOW))
  assert.deepEqual(homes(db).map((r) => `${r.id}@${r.deck_id}`), before)
})

test('deleting a filtered deck the generic way keeps the cards, and the repair finds them', () => {
  const db = collection()
  const before = homes(db).map((r) => `${r.id}@${r.deck_id}`)
  build(db, cfg({ search: '' }))

  // Exactly what repo.deleteDeck does: release deck_id, then drop the row.
  db.exec(`UPDATE cards SET deck_id = NULL WHERE deck_id = 'cram'`)
  db.exec(`DELETE FROM decks WHERE id = 'cram'`)
  assert.equal(rows(db, 'SELECT id FROM cards').length, 3, 'cards must never cascade away')

  run(db, returnStrandedStmt(NOW))
  assert.deepEqual(homes(db).map((r) => `${r.id}@${r.deck_id}`), before)
})

test('one card goes home without disturbing the rest of the session', () => {
  const db = collection()
  build(db, cfg({ search: 'tag:exam' }))
  run(db, returnCardStmt('n1:0', NOW))

  assert.equal(homes(db).find((r) => r.id === 'n1:0')!.deck_id, null)
  assert.equal(homes(db).find((r) => r.id === 'n2:0')!.deck_id, 'cram')
})

test('the limit and the order are the ones the form promised', () => {
  const db = collection()
  const m = matchSql(cfg({ search: 'tag:exam', limit: 1 }), NOW)
  const picked = db.prepare(m.sql).all(...(m.params as never[])) as { id: string }[]
  assert.deepEqual(picked.map((r) => r.id), ['n1:0'], 'due order takes the overdue card first')

  build(db, cfg({ search: 'tag:exam', limit: 1 }))
  assert.equal(rows(db, `SELECT id FROM cards WHERE deck_id = 'cram'`).length, 1)
})

test('a config round-trips, and a junk one falls back rather than throwing', () => {
  assert.deepEqual(parseFilterConfig('{"search":"tag:x","limit":5,"order":"random","reschedule":false}'), {
    search: 'tag:x', limit: 5, order: 'random', reschedule: false,
  })
  assert.deepEqual(parseFilterConfig('not json'), DEFAULT_FILTER)
  assert.equal(parseFilterConfig('{"limit":0}').limit, 1)
  assert.equal(parseFilterConfig('{"order":"drop table"}').order, 'due')
})
