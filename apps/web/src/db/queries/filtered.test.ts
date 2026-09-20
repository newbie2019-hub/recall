import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { registerHooks } from 'node:module'
import { MIGRATIONS, applyReview, newCard, Rating, type RatingValue } from '@recall/core'
import type { StudyCard } from '../repo.ts'

// Vite resolves `./client`; node does not. Five lines here beat either a bundler
// in the test path or `.ts` extensions spreading through the app's imports.
registerHooks({
  resolve(spec, ctx, next) {
    try {
      return next(spec, ctx)
    } catch {
      return next(`${spec}.ts`, ctx)
    }
  },
})
const { db } = await import('../client.ts')
const { answerCard, emptyFilteredDeck, matchCount, rebuild } = await import('./filtered.ts')

/**
 * The real statements against a real SQLite, with the worker RPC swapped for an
 * in-process `node:sqlite` — stdlib, no runner to install, and the same SQL the
 * sqlite-wasm worker runs.
 *
 *   node --test apps/web/src/db/queries/filtered.test.ts
 *
 * It covers the one thing the core suite cannot: what an *answer* does, which
 * is where "reschedule off" is either honest or a lie.
 */
const NOW = Date.UTC(2026, 8, 19)
const DAY = 86_400_000

let sql: DatabaseSync
const all = (q: string, p: unknown[] = []) => sql.prepare(q).all(...(p as never[]))

before(() => {
  sql = new DatabaseSync(':memory:')
  sql.exec('PRAGMA foreign_keys = ON')
  for (const m of MIGRATIONS) sql.exec(m)

  // The worker's three entry points, in process.
  db.select = async (q: string, p: unknown[] = []) => all(q, p) as never
  db.run = async (q: string, p: unknown[] = []) => void sql.prepare(q).run(...(p as never[]))
  db.batch = async (stmts) => {
    sql.exec('BEGIN')
    try {
      for (const s of stmts) sql.prepare(s.sql).run(...((s.params ?? []) as never[]))
      sql.exec('COMMIT')
    } catch (e) {
      sql.exec('ROLLBACK')
      throw e
    }
  }
})

/** A card whose row is exactly what its log replays to — the app's invariant. */
function seed() {
  sql.exec(`
    DELETE FROM reviews; DELETE FROM cards; DELETE FROM notes; DELETE FROM decks;
    DELETE FROM note_types;
    INSERT INTO decks (id, parent_id, name, retention_target, new_per_day)
      VALUES ('home', NULL, 'Anatomy', 0.95, 20);
    INSERT INTO decks (id, parent_id, name, new_per_day, filtered, filter_config)
      VALUES ('cram', NULL, 'Exam', 9999, 1, '{"search":"tag:exam","limit":10,"order":"due","reschedule":false}');
    INSERT INTO notes (id, note_type, deck_id, fields, tags, guid, updated_at)
      VALUES ('n1', 'basic', 'home', '{"Front":"a","Back":"b"}', ' exam ', 'g1', 0);
    INSERT INTO note_types (id, name, fields, templates)
      VALUES ('basic', 'Basic', '["Front","Back"]', '[{"name":"Card 1","qfmt":"{{Front}}","afmt":"{{Back}}"}]');
  `)

  // Two learning steps and two Easies, which leaves the card genuinely not due
  // for months — the case a cram exists for.
  let card = newCard('n1:0', 'n1', 0, NOW - 60 * DAY)
  const log: [number, RatingValue][] = [
    [NOW - 60 * DAY, Rating.Good], [NOW - 60 * DAY + 600_000, Rating.Good],
    [NOW - 50 * DAY, Rating.Easy], [NOW - 20 * DAY, Rating.Easy],
  ]
  for (const [ts, rating] of log) {
    card = applyReview(card, rating, ts, 0.95)
    sql.prepare(
      `INSERT INTO reviews (id, card_id, ts, rating, duration_ms) VALUES (?, 'n1:0', ?, ?, 0)`,
    ).run(`r${ts}`, ts, rating)
  }
  sql.prepare(
    `INSERT INTO cards (id, note_id, ord, due, stability, difficulty, state, learning_steps,
                        reps, lapses, last_review)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run('n1:0', 'n1', 0, card.due, card.stability, card.difficulty, card.state,
        card.learning_steps, card.reps, card.lapses, card.last_review)
  assert.ok(card.due > NOW, 'fixture: the card must not be due yet, or nothing is pulled forward')
  return card
}

const studyCard = (): StudyCard => {
  const [row] = all('SELECT * FROM cards WHERE id = ?', ['n1:0']) as Record<string, never>[]
  return {
    card: { ...row!, suspended: false } as never,
    note: { id: 'n1', note_type: 'basic', deck_id: 'home', fields: {}, tags: [], fma_id: null, updated_at: 0 },
    noteType: { id: 'basic', name: 'Basic', fields: [], templates: [], css: '', kind: 'standard' } as never,
    deckPath: 'Exam',
    maxAnswerSeconds: 60,
    deckName: 'Exam',
    // What nextCard would hand over: the *filtered* deck's target, not home's.
    retentionTarget: 0.9,
  }
}

const due = () => (all('SELECT due FROM cards WHERE id = ?', ['n1:0'])[0] as { due: number }).due
const deckOf = () =>
  (all('SELECT deck_id FROM cards WHERE id = ?', ['n1:0'])[0] as { deck_id: string | null }).deck_id
const reviewCount = () => (all('SELECT COUNT(*) AS n FROM reviews')[0] as { n: number }).n

test('build pulls a not-yet-due card forward; empty puts its real due date back', async () => {
  const original = seed()
  assert.equal(await matchCount({ search: 'tag:exam', limit: 10, order: 'due', reschedule: false }), 1)

  assert.equal(await rebuild('cram', undefined, NOW), 1)
  assert.equal(deckOf(), 'cram')
  assert.equal(due(), NOW)

  await emptyFilteredDeck('cram', NOW)
  assert.equal(deckOf(), null)
  assert.equal(due(), original.due, 'replaying the log restores the exact due date')
})

test('reschedule off writes nothing to the log and leaves the schedule alone', async () => {
  const original = seed()
  await rebuild('cram', undefined, NOW)
  const before = reviewCount()

  await answerCard(studyCard(), Rating.Again, 1200, NOW)

  assert.equal(reviewCount(), before, 'a cram answer must not enter the append-only log')
  assert.equal(due(), original.due, 'and must not move the card')
  assert.equal(deckOf(), null, 'the card leaves the deck, or the session cannot advance')
})

test('reschedule on logs a real review, at the home deck’s retention target', async () => {
  seed()
  sql.prepare(`UPDATE decks SET filter_config = ? WHERE id = 'cram'`).run(
    '{"search":"tag:exam","limit":10,"order":"due","reschedule":true}',
  )
  await rebuild('cram', undefined, NOW)

  const shown = studyCard()
  const next = await answerCard(shown, Rating.Good, 1200, NOW)
  assert.equal(reviewCount(), 5)
  assert.equal(deckOf(), 'cram', 'a rescheduling cram keeps the card until the deck is emptied')

  // 0.95 is home's target; the cram deck's 0.9 would schedule further out, and
  // the next rebuild — which replays at home's target — would silently disagree.
  const atHome = applyReview(shown.card, Rating.Good, NOW, 0.95)
  assert.equal(next.due, atHome.due)
})
