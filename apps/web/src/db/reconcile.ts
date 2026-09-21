/**
 * Keeping a database honest about its own schema.
 *
 * Extracted from the worker so it can be run against `node:sqlite` in a test —
 * this is the one piece of the boot path that writes DDL to somebody's
 * collection, and it is not the sort of code to ship unexercised.
 */
import { MIGRATIONS } from '@recall/core'

/** The little of SQLite this needs, so the worker and a test can both supply it. */
export interface SchemaDb {
  exec(sql: string): void
  selectObjects(sql: string): Record<string, unknown>[]
  transaction(fn: () => void): void
  close?(): void
}

/**
 * A cheap stamp of *what the migrations said*, not how many there were.
 *
 * `user_version` counts migrations, which is the right cursor for applying them
 * and useless for noticing that one of them changed. Two databases can both
 * report "10 applied" and hold different schemas if migration 6 grew after the
 * first one ran it. This is the number that differs when that happens.
 */
export function migrationStamp(): number {
  let h = 2166136261
  const all = MIGRATIONS.join('\u0000')
  for (let i = 0; i < all.length; i++) {
    h ^= all.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  // `application_id` is a signed 32-bit integer.
  return h | 0
}

export interface ColumnInfo { name: string; type: string; notnull: number; dflt_value: string | null }

const columnsOf = (db: SchemaDb, table: string): ColumnInfo[] =>
  db.selectObjects(`PRAGMA table_info(${JSON.stringify(table)})`) as unknown as ColumnInfo[]

/** `name TEXT NOT NULL DEFAULT 0`, rebuilt from what SQLite kept. */
function definition(c: ColumnInfo): string {
  const notNull = c.notnull ? ' NOT NULL' : ''
  const dflt = c.dflt_value === null ? '' : ` DEFAULT ${c.dflt_value}`
  return `${JSON.stringify(c.name)} ${c.type || 'TEXT'}${notNull}${dflt}`
}

/**
 * Bring a database back in line with what the migrations actually say.
 *
 * **The bug this exists for:** `user_version` is a count, so a database that
 * has run all ten migrations skips all ten forever — including a migration that
 * was *edited* after it ran. Every long-lived development database is one
 * amended migration away from a missing column, and the symptom is a dead
 * screen reading `no such column` on a table that has been there since Phase 1.
 *
 * Rather than keep a hand-written manifest of the expected schema (which is the
 * same thing that drifted in the first place), the migrations are replayed into
 * a throwaway in-memory database and the two are diffed. The reference is
 * therefore always correct by construction.
 *
 * Non-destructive by design: it only ever *adds* — missing tables, then missing
 * columns, then missing indexes and triggers, in that order because each needs
 * the one before it. It never drops or rewrites anything, so a column this
 * cannot explain is left alone rather than taken away with somebody's data
 * inside it.
 *
 * Two things it cannot recover, both harmless and both worth knowing:
 * `PRAGMA table_info` does not report foreign-key clauses, so a re-added column
 * comes back without its `REFERENCES`; and a `NOT NULL` column with no default
 * cannot be added to a table with rows in it, so it is skipped and named in the
 * console rather than failing the whole open.
 */
export function reconcile(db: SchemaDb, scratch: () => SchemaDb): string[] {
  const reference = scratch()
  const repairs: string[] = []

  try {
    for (const m of MIGRATIONS) reference.exec(m)

    const listing = (d: SchemaDb) =>
      d.selectObjects(
        `SELECT name, type, sql FROM sqlite_master
          WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`,
      ) as unknown as { name: string; type: string; sql: string }[]

    const want = listing(reference)
    const have = new Set(listing(db).map((o) => o.name))

    // Tables first: an index cannot be created on a table that is not there.
    for (const o of want) {
      if (o.type === 'table' && !have.has(o.name)) repairs.push(o.sql)
    }

    // Then the columns an amended migration added to a table that already
    // existed — the case that actually bites.
    for (const o of want) {
      if (o.type !== 'table' || !have.has(o.name)) continue
      const mine = new Set(columnsOf(db, o.name).map((c) => c.name))
      for (const c of columnsOf(reference, o.name)) {
        if (mine.has(c.name)) continue
        if (c.notnull && c.dflt_value === null) {
          console.warn(`[db] cannot re-add ${o.name}.${c.name}: NOT NULL with no default`)
          continue
        }
        repairs.push(`ALTER TABLE ${JSON.stringify(o.name)} ADD COLUMN ${definition(c)}`)
      }
    }

    // Indexes and triggers last, now that everything they name exists.
    for (const o of want) {
      if (o.type !== 'table' && !have.has(o.name)) repairs.push(o.sql)
    }

    if (repairs.length) {
      console.warn(`[db] schema drift: applying ${repairs.length} repair(s)`, repairs)
      db.transaction(() => {
        for (const sql of repairs) db.exec(sql)
      })
    }
  } finally {
    reference.close?.()
  }

  return repairs
}
