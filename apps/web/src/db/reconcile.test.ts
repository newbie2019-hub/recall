/**
 * The schema repair, run against a real SQLite.
 *
 * This reproduces the failure that produced it: a database that reports every
 * migration applied and is nonetheless missing a column, because the migration
 * that added it was edited after that database ran it. The symptom was
 * `no such column: dk.bury_new` on a dead screen, and it is unreachable by any
 * amount of care at the call sites — `user_version` is a count, and a count
 * cannot notice that the thing it counted changed.
 *
 *   node --experimental-strip-types --test apps/web/src/db/reconcile.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS } from '@recall/core'
import { migrationStamp, reconcile, type SchemaDb } from './reconcile.ts'

/** `node:sqlite` wearing the two and a half methods the repair uses. */
function adapt(sqlite: DatabaseSync): SchemaDb {
  return {
    exec: (sql) => sqlite.exec(sql),
    selectObjects: (sql) => sqlite.prepare(sql).all() as Record<string, unknown>[],
    transaction: (fn) => {
      sqlite.exec('BEGIN')
      try { fn(); sqlite.exec('COMMIT') } catch (e) { sqlite.exec('ROLLBACK'); throw e }
    },
    close: () => sqlite.close(),
  }
}

const scratch = () => adapt(new DatabaseSync(':memory:'))

const columns = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as { name: string }[])
    .map((c) => c.name)

/** A database built from migrations with one ALTER removed — an amended migration. */
function drifted(...drop: string[]): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (const m of MIGRATIONS) {
    db.exec(drop.reduce((sql, line) => sql.replace(line, ''), m))
  }
  db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`)
  return db
}

test('a healthy database is left completely alone', () => {
  const db = new DatabaseSync(':memory:')
  for (const m of MIGRATIONS) db.exec(m)

  const before = columns(db, 'decks')
  assert.deepEqual(reconcile(adapt(db), scratch), [], 'nothing to repair')
  assert.deepEqual(columns(db, 'decks'), before, 'and nothing touched')
})

test('a column lost to an amended migration comes back', () => {
  // The reported failure, exactly: `no such column: dk.bury_new` from a
  // database that believes it is fully migrated.
  const db = drifted('ALTER TABLE decks ADD COLUMN bury_new        INTEGER NOT NULL DEFAULT 1;')
  assert.ok(!columns(db, 'decks').includes('bury_new'), 'the fixture really is broken')

  const repairs = reconcile(adapt(db), scratch)

  assert.equal(repairs.length, 1)
  assert.match(repairs[0]!, /ADD COLUMN "bury_new" INTEGER NOT NULL DEFAULT 1/)
  assert.ok(columns(db, 'decks').includes('bury_new'))
  // The default has to survive, or every existing deck reads as "do not bury".
  db.exec(`INSERT INTO decks (id, parent_id, name) VALUES ('d1', NULL, 'Thorax')`)
  assert.equal(
    (db.prepare('SELECT bury_new FROM decks').get() as { bury_new: number }).bury_new,
    1,
  )
})

test('rows already in the table keep their data', () => {
  // The whole reason this repairs rather than rebuilds: a wipe is the other
  // fix, and it costs somebody every card they had not synced.
  const db = drifted('ALTER TABLE decks ADD COLUMN bury_new        INTEGER NOT NULL DEFAULT 1;')
  db.exec(`INSERT INTO decks (id, parent_id, name) VALUES ('d1', NULL, 'Thorax')`)

  reconcile(adapt(db), scratch)

  const row = db.prepare('SELECT name, bury_new FROM decks').get() as Record<string, unknown>
  assert.equal(row.name, 'Thorax')
  assert.equal(row.bury_new, 1)
})

test('several losses across several tables are all found', () => {
  const db = drifted(
    'ALTER TABLE decks ADD COLUMN bury_new        INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE decks ADD COLUMN audio_autoplay INTEGER NOT NULL DEFAULT 0;',
    'ALTER TABLE cards ADD COLUMN due_override INTEGER;',
  )

  assert.equal(reconcile(adapt(db), scratch).length, 3)
  assert.ok(columns(db, 'decks').includes('bury_new'))
  assert.ok(columns(db, 'decks').includes('audio_autoplay'))
  assert.ok(columns(db, 'cards').includes('due_override'))
  assert.deepEqual(reconcile(adapt(db), scratch), [], 'and it is idempotent')
})

test('a missing table is created before the index that names it', () => {
  const db = new DatabaseSync(':memory:')
  for (const m of MIGRATIONS) db.exec(m)
  db.exec('DROP TABLE pomodoro_sessions')

  const repairs = reconcile(adapt(db), scratch)

  assert.ok(repairs[0]!.startsWith('CREATE TABLE'), 'the table comes first')
  assert.ok(repairs.some((r) => r.startsWith('CREATE INDEX')), 'and its index after')
  db.exec(`INSERT INTO pomodoro_sessions (id, kind, started_at, planned_ms)
           VALUES ('p1', 'focus', 0, 1)`)
})

test('the stamp changes when a migration changes, and not otherwise', () => {
  // It is what stops the repair running on every launch, so a stamp that did
  // not move on an edit would leave this code never running at all.
  assert.equal(migrationStamp(), migrationStamp())
  assert.equal(typeof migrationStamp(), 'number')
  assert.ok(Number.isInteger(migrationStamp()))
})
