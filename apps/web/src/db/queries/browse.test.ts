/**
 * The browser's SQL, run against a real SQLite.
 *
 * `node:sqlite` is the same engine as the wasm build in the worker, so the
 * compiled search, the `json_each` write-back and the tag rollup are checked
 * rather than asserted about. The worker RPC is swapped for an in-memory
 * database — nothing here mocks a *result*, only the transport.
 *
 * The thing under test is rule 4: the count, the page and the rows a bulk
 * operation touches must all be the same set.
 *
 *   node --experimental-strip-types --test apps/web/src/db/queries/browse.test.ts
 */
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { MIGRATIONS, parseSearch } from '@recall/core'
import { db } from '../client.ts'
import * as browse from './browse.ts'

const DAY = 86_400_000
const NOW = Date.now()
const sqlite = new DatabaseSync(':memory:')

/** Every query in `browse.ts` binds positionally, so there is nothing to key. */
const bind = (params: unknown[]) => params as SQLInputValue[]

const q = (s: string) => parseSearch(s)

before(() => {
  for (const m of MIGRATIONS) sqlite.exec(m)
  db.select = async <T,>(sql: string, params: unknown[] = []) =>
    sqlite.prepare(sql).all(...bind(params)) as T[]
  db.run = async (sql: string, params: unknown[] = []) => {
    sqlite.prepare(sql).run(...bind(params))
  }
  // `bulkForget` refolds the log through `replayCards`, which batches.
  db.batch = async (stmts: { sql: string; params?: unknown[] }[]) => {
    for (const st of stmts) sqlite.prepare(st.sql).run(...bind(st.params ?? []))
  }
})

/** A small collection: two decks, one nested, three notes, six cards. */
beforeEach(() => {
  sqlite.exec('DELETE FROM cards; DELETE FROM notes; DELETE FROM decks; DELETE FROM note_types')
  sqlite.exec(`
    INSERT INTO decks (id, parent_id, name) VALUES
      ('d1', NULL, 'Anatomy'), ('d2', 'd1', 'Thorax'), ('d3', NULL, 'Pharm');
    INSERT INTO note_types (id, name, fields, templates, sort_field) VALUES
      ('nt', 'Basic', '["Front","Back"]',
       '[{"name":"Recognition"},{"name":"Recall"}]', 0);
    INSERT INTO notes (id, note_type, deck_id, fields, tags, guid, updated_at) VALUES
      ('n1', 'nt', 'd2', '{"Front":"<b>Mitral</b> valve","Back":"bicuspid"}',
       'anatomy::thorax::valves marked', 'g1', 10),
      ('n2', 'nt', 'd2', '{"Front":"Aortic valve","Back":"tricuspid"}',
       'anatomy::thorax::valves leech', 'g2', 20),
      ('n3', 'nt', 'd3', '{"Front":"Aspirin","Back":"COX"}', 'pharm', 'g3', 30);
    INSERT INTO cards (id, note_id, ord, due, state, lapses, reps, flag, suspended) VALUES
      ('n1:0', 'n1', 0, ${NOW - DAY}, 'review', 5, 20, 0, 0),
      ('n1:1', 'n1', 1, ${NOW + 30 * DAY}, 'review', 0, 3, 1, 0),
      ('n2:0', 'n2', 0, ${NOW - 2 * DAY}, 'relearning', 9, 40, 0, 0),
      ('n2:1', 'n2', 1, 0, 'new', 0, 0, 0, 0),
      ('n3:0', 'n3', 0, ${NOW + 2 * DAY}, 'review', 1, 8, 2, 1),
      ('n3:1', 'n3', 1, 0, 'new', 0, 0, 0, 0);
  `)
})

test('an empty search is every card', async () => {
  assert.equal(await browse.browseCount([]), 6)
})

test('deck: follows the tree, not just the named deck', async () => {
  assert.equal(await browse.browseCount(q('deck:Anatomy')), 4)
  assert.equal(await browse.browseCount(q('deck:Thorax')), 4)
  assert.equal(await browse.browseCount(q('deck:Pharm')), 2)
})

test('tag: reaches children; a reserved tag is just a tag', async () => {
  assert.equal(await browse.browseCount(q('tag:anatomy')), 4)
  assert.equal(await browse.browseCount(q('tag:anatomy::thorax::valves')), 4)
  assert.equal(await browse.browseCount(q('is:marked')), 2)
  assert.equal(await browse.browseCount(q('is:leech')), 2)
})

test('state, flag, lapses and due each narrow, and they compose', async () => {
  assert.equal(await browse.browseCount(q('is:new')), 2)
  assert.equal(await browse.browseCount(q('is:due')), 2)
  assert.equal(await browse.browseCount(q('is:suspended')), 1)
  assert.equal(await browse.browseCount(q('flag:1')), 1)
  assert.equal(await browse.browseCount(q('lapses:>=5')), 2)
  assert.equal(await browse.browseCount(q('due:30')), 4)
  assert.equal(await browse.browseCount(q('lapses:>=5 deck:Anatomy -is:suspended')), 2)
})

test('the page and the count agree, whatever the sort', async () => {
  const terms = q('deck:Anatomy')
  const total = await browse.browseCount(terms)
  const first = await browse.browseCards(terms, 'lapses', 'desc', 3, 0)
  const second = await browse.browseCards(terms, 'lapses', 'desc', 3, 3)
  assert.equal(first.length + second.length, total)
  assert.deepEqual(first.map((c) => c.lapses), [9, 5, 0])
  // Preview is the sort field, stripped of HTML; template comes from the type.
  assert.equal(first[0]!.preview, 'Aortic valve')
  assert.equal(first[0]!.template, 'Recognition')
  assert.deepEqual(first[0]!.tags, ['anatomy::thorax::valves', 'leech'])
})

test('the tag tree nests and rolls counts into every ancestor', async () => {
  const roots = await browse.tagTree()
  assert.deepEqual(roots.map((r) => r.tag), ['anatomy', 'pharm'])
  const anatomy = roots[0]!
  assert.equal(anatomy.cards, 4)
  assert.equal(anatomy.children[0]!.tag, 'anatomy::thorax')
  assert.equal(anatomy.children[0]!.children[0]!.label, 'valves')
  assert.equal(anatomy.children[0]!.children[0]!.depth, 2)
  // Reserved tags are lifted out of the tree, not silently merged into it.
  assert.equal(roots.find((r) => r.tag === 'marked'), undefined)
})

test('a count is a promise: suspending "all matching" suspends exactly those', async () => {
  const terms = q('lapses:>=5')
  const promised = await browse.browseCount(terms)
  assert.equal(promised, 2)

  const undo = await browse.bulkSuspend({ terms }, true, NOW)
  assert.equal(undo.count, promised)
  assert.equal(await browse.browseCount(q('is:suspended')), 3) // the two plus n3:0

  await undo.run()
  assert.equal(await browse.browseCount(q('is:suspended')), 1)
})

test('undo restores only the rows that moved', async () => {
  // n3:0 is already suspended; suspending everything must leave it alone so
  // undo does not un-suspend a card the operation never touched.
  const undo = await browse.bulkSuspend({ terms: [] }, true, NOW)
  assert.equal(undo.count, 5)
  await undo.run()
  const [row] = await db.select<{ suspended: number }>(`SELECT suspended FROM cards WHERE id = 'n3:0'`)
  assert.equal(row!.suspended, 1)
})

test('bulk flag and move write card_states and are undoable', async () => {
  const target = { ids: ['n1:0', 'n1:1'] }
  const flag = await browse.bulkFlag(target, 3, NOW)
  assert.equal(flag.count, 2)
  assert.equal(await browse.browseCount(q('flag:3')), 2)

  const move = await browse.bulkMove(target, 'd3', NOW)
  assert.equal(await browse.browseCount(q('deck:Pharm')), 4)
  const [c] = await db.select<{ state_updated_at: number }>(
    `SELECT state_updated_at FROM cards WHERE id = 'n1:0'`,
  )
  assert.equal(c!.state_updated_at, NOW)

  await move.run()
  await flag.run()
  assert.equal(await browse.browseCount(q('deck:Pharm')), 2)
  assert.equal(await browse.browseCount(q('flag:3')), 0)
})

test('reschedule writes the override as well as the cache, so it can travel', async () => {
  const target = { terms: q('deck:Anatomy') }
  assert.equal(await browse.targetCount(target), 4)
  // The dialog's number and the operation's number are the same query.
  assert.equal(await browse.targetCount(target, browse.RESCHEDULABLE), 3)

  const undo = await browse.bulkReschedule(target, 7, NOW)
  assert.equal(undo.count, 3)

  const rows = await db.select<{ id: string; due: number; state: string }>(
    `SELECT id, due, state FROM cards WHERE note_id IN ('n1','n2') ORDER BY id`,
  )
  for (const r of rows) {
    assert.equal(r.due, r.state === 'new' ? 0 : NOW + 7 * DAY, r.id)
  }
  // Rule 1: rescheduling is not a review.
  const [n] = await db.select<{ n: number }>('SELECT COUNT(*) AS n FROM reviews')
  assert.equal(n!.n, 0)

  // The regression this line exists for: `due` alone is a cache that every
  // other device rebuilds from the log, so a date written only there is
  // invisible on the phone. The override is the copy that syncs.
  const [carried] = await db.select<{ due_override: number | null; state_updated_at: number }>(
    `SELECT due_override, state_updated_at FROM cards WHERE id = 'n1:1'`,
  )
  assert.equal(carried!.due_override, NOW + 7 * DAY)
  assert.equal(carried!.state_updated_at, NOW, 'without the stamp the push loop never finds it')

  await undo.run()
  const [back] = await db.select<{ due: number; due_override: number | null }>(
    `SELECT due, due_override FROM cards WHERE id = 'n1:1'`,
  )
  assert.equal(back!.due, NOW + 30 * DAY)
  assert.equal(back!.due_override, null, 'undo has to clear the override, not just the cache')
})

test('postpone slides each card from its own date; reschedule flattens them', async () => {
  // The distinction the two dialogs exist to keep: a backlog is not fixed by
  // giving four thousand cards the same day.
  const target = { terms: q('deck:Anatomy') }
  await browse.bulkShift(target, 7, NOW)

  const rows = await db.select<{ id: string; due: number }>(
    `SELECT id, due FROM cards WHERE id IN ('n1:0','n1:1','n2:0') ORDER BY id`,
  )
  assert.equal(rows[0]!.due, NOW - DAY + 7 * DAY)
  assert.equal(rows[1]!.due, NOW + 30 * DAY + 7 * DAY)
  assert.equal(rows[2]!.due, NOW - 2 * DAY + 7 * DAY)
})

test('advancing never pulls a card earlier than today', async () => {
  // A date in the past would put the card at the head of the queue in an order
  // nobody chose, which is worse than the backlog it was meant to relieve.
  await browse.bulkShift({ ids: ['n1:1'] }, -365, NOW)
  const [r] = await db.select<{ due: number }>(`SELECT due FROM cards WHERE id = 'n1:1'`)
  assert.equal(r!.due, NOW)
})

test('forget resets the card and keeps every answer in the log', async () => {
  sqlite.exec(`
    INSERT INTO reviews (id, card_id, ts, rating, duration_ms) VALUES
      ('rv1', 'n1:0', ${NOW - 20 * DAY}, 3, 1000),
      ('rv2', 'n1:0', ${NOW - 10 * DAY}, 3, 1000);
  `)

  const undo = await browse.bulkForget({ ids: ['n1:0'] }, NOW)
  assert.equal(undo.count, 1)

  const [card] = await db.select<{ state: string; reps: number; forgotten_at: number | null }>(
    `SELECT state, reps, forgotten_at FROM cards WHERE id = 'n1:0'`,
  )
  assert.equal(card!.state, 'new')
  assert.equal(card!.reps, 0)
  assert.equal(card!.forgotten_at, NOW)

  const [n] = await db.select<{ n: number }>(`SELECT COUNT(*) AS n FROM reviews WHERE card_id = 'n1:0'`)
  assert.equal(n!.n, 2, 'the log is append-only; forgetting is not deleting')

  // And it is reversible, which is only true because nothing was thrown away.
  await undo.run()
  const [back] = await db.select<{ state: string; reps: number; forgotten_at: number | null }>(
    `SELECT state, reps, forgotten_at FROM cards WHERE id = 'n1:0'`,
  )
  assert.equal(back!.forgotten_at, null)
  assert.equal(back!.state, 'review')
  assert.equal(back!.reps, 2)
})

test('retag reaches every card of a selected note, and is idempotent', async () => {
  // One card of n1 selected; the tag has to land on the note, so both cards
  // of n1 answer `tag:exam` afterwards.
  const add = await browse.bulkRetag({ ids: ['n1:0'] }, 'exam', true, NOW)
  assert.equal(add.count, 1)
  assert.equal(await browse.browseCount(q('tag:exam')), 2)

  const again = await browse.bulkRetag({ ids: ['n1:0'] }, 'exam', true, NOW)
  assert.equal(again.count, 0, 'a tag already present is not a change')

  await add.run()
  assert.equal(await browse.browseCount(q('tag:exam')), 0)
})
