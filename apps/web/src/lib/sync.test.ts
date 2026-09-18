import { SYNC_RESOURCES, type SyncChange, type SyncPayload, type SyncResourceName } from '@recall/core'
import type { LocalBatch } from '../db/queries/sync'
import { type Store, type Transport, chunkPayload, syncOnce } from './sync.ts'

/**
 * The round trip, on a fake server that does what the real one does: echo back
 * what it was given, stamped with a revision.
 *
 * Local rows → push payload → pulled changes → local rows. If a column is
 * renamed on one side of the mapping and not the other, or a boolean stops
 * surviving SQLite's 0/1, this is where it shows.
 *
 * Run: `node apps/web/src/lib/sync.test.ts` (or `pnpm --filter @recall/web test`).
 * No `node:test` import on purpose — `apps/web` has no `@types/node`, and a test
 * that breaks `tsc -b` is worse than a test that prints its own failures.
 */

let failures = 0

const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort())
      : x)

function check(what: string, got: unknown, want: unknown): void {
  if (canon(got) === canon(want)) return
  failures++
  console.error(`FAIL  ${what}\n  got      ${canon(got)}\n  expected ${canon(want)}`)
}

function ok(what: string, condition: boolean): void {
  if (condition) return
  failures++
  console.error(`FAIL  ${what}`)
}

// ── fixtures ──────────────────────────────────────────────────────────────

const empty = (): LocalBatch => ({
  decks: [], note_types: [], notes: [], card_states: [], reviews: [], media: [], tombstones: [],
})

const seed: LocalBatch = {
  decks: [{ id: 'deck-1', parent_id: null, name: 'Anatomy', retention_target: 0.9, new_per_day: 20, updated_at: 1000 }],
  note_types: [{
    id: 'basic', name: 'Basic', fields: '["Front","Back"]',
    templates: '[{"name":"Card 1","qfmt":"{{Front}}","afmt":"{{Back}}"}]',
    css: '.card{}', kind: 'standard', ord_field: null, sort_field: 0,
    field_config: '[]', anki_extra: '{}', builtin: 1, updated_at: 1100,
  }],
  notes: [{
    id: 'note-1', guid: 'abcd1234', note_type: 'basic', deck_id: 'deck-1',
    fields: '{"Front":"heart","Back":"cor"}', tags: 'anatomy thorax',
    fma_id: 'FMA:7088', checksum: 12345, updated_at: 1200,
  }],
  card_states: [{
    id: 'note-1:0', note_id: 'note-1', ord: 0, suspended: 1,
    buried_until: null, flag: 2, deck_id: 'deck-2', state_updated_at: 1300,
  }],
  reviews: [{ id: 'rev-1', card_id: 'note-1:0', ts: 1400, rating: 3, duration_ms: 900, imported: 0 }],
  media: [{ sha256: 'ff00', mime: 'image/png', size: 12, created_at: 1500 }],
  tombstones: [{ resource: 'decks', key: 'deck-gone', deleted_at: 1600 }],
}

/** Records what the loop asked the collection to do, and in what order. */
function fakeStore(batch: LocalBatch, cursorStart = 0) {
  const applied = empty()
  const removed: Partial<Record<SyncResourceName, string[]>> = {}
  const events: string[] = []
  let cursor = cursorStart
  let pushedAt = -1

  const store: Store = {
    readState: async () => ({ cursor, userId: 'user-1', pushedAt }),
    writeCursor: async (c) => { events.push(`cursor:${c}`); cursor = c },
    adoptInto: async () => { events.push('adopt') },
    collectLocal: async () => batch,
    markPushed: async (_b, at) => { events.push('markPushed'); pushedAt = at },
    putDecks: async (rows) => { events.push('put:decks'); applied.decks.push(...rows) },
    putNoteTypes: async (rows) => { applied.note_types.push(...rows) },
    putNotes: async (rows) => { applied.notes.push(...rows) },
    putCardStates: async (rows) => { applied.card_states.push(...rows) },
    putReviews: async (rows) => { events.push('put:reviews'); applied.reviews.push(...rows) },
    remove: async (resource, keys) => {
      if (keys.length) removed[resource] = [...(removed[resource] ?? []), ...keys]
    },
  }
  return { store, applied, removed, events, cursor: () => cursor, pushedAt: () => pushedAt }
}

/** What the server sends back: the same rows, in revision order. */
function echo(chunks: SyncPayload[]): Record<SyncResourceName, SyncChange[]> {
  const out: Record<SyncResourceName, SyncChange[]> = {
    decks: [], note_types: [], notes: [], card_states: [], reviews: [], media: [],
  }
  let revision = 0
  for (const chunk of chunks) {
    for (const name of SYNC_RESOURCES) {
      for (const row of chunk[name] ?? []) out[name].push({ ...row, revision: ++revision })
    }
  }
  return out
}

function fakeTransport(pages: (pushed: SyncPayload[]) => { changes: Record<SyncResourceName, SyncChange[]>; next_cursor: number | null; has_more: boolean }[]) {
  const pushed: SyncPayload[] = []
  let pull = 0
  const transport: Transport = {
    push: async (p) => { pushed.push(p); return { applied: {}, skipped: {} } },
    pull: async () => {
      const page = pages(pushed)[pull++] ?? { changes: echo([]), next_cursor: null, has_more: false }
      return { ...page, server_time: 0 }
    },
  }
  return { transport, pushed, pulls: () => pull }
}

// ── the round trip ────────────────────────────────────────────────────────

await (async () => {
  const local = fakeStore(seed)
  const net = fakeTransport((pushed) => [{ changes: echo(pushed), next_cursor: 9, has_more: false }])
  await syncOnce(net.transport, 'user-1', local.store)

  const payload = net.pushed[0] ?? {}

  check('deck survives the round trip', local.applied.decks, seed.decks)
  check('note type survives the round trip', local.applied.note_types, seed.note_types)
  check('note survives the round trip', local.applied.notes, seed.notes)
  check('card state survives the round trip', local.applied.card_states, seed.card_states)
  check('review survives the round trip', local.applied.reviews, seed.reviews)

  check('local column names are translated', Object.keys(payload.notes?.[0] ?? {}).sort(),
    ['checksum', 'client_updated_at', 'deck_id', 'fields', 'fma_id', 'guid', 'id', 'note_type_id', 'tags'])
  check('a review goes up as client_ts', payload.reviews?.[0], {
    id: 'rev-1', card_id: 'note-1:0', client_ts: 1400, rating: 3, duration_ms: 900, imported: false,
  })

  // The one column list that must never grow: shipping the FSRS cache would put
  // the server in an argument with replayReviews().
  check('card_states carries only what a person decided',
    Object.keys(payload.card_states?.[0] ?? {}).sort(),
    ['buried_until', 'client_updated_at', 'deck_id', 'flag', 'id', 'note_id', 'ord', 'suspended'])

  check('media goes up as metadata', payload.media, [
    { sha256: 'ff00', mime: 'image/png', size: 12, client_updated_at: 1500 },
  ])
  ok('pulled media is not applied', local.applied.media.length === 0)

  check('a tombstone travels as a deleted key', payload.decks?.[1],
    { id: 'deck-gone', client_updated_at: 1600, deleted: true })
  check('a pulled delete deletes locally', local.removed.decks, ['deck-gone'])

  check('the watermark is the newest row pushed, not the clock', local.pushedAt(), 1300)
  check('the cursor advances only after the page is applied',
    local.events, ['adopt', 'markPushed', 'put:decks', 'put:reviews', 'cursor:9'])
})()

// ── paging ────────────────────────────────────────────────────────────────

await (async () => {
  const local = fakeStore(empty())
  const net = fakeTransport(() => [
    { changes: echo([]), next_cursor: 5, has_more: true },
    { changes: echo([]), next_cursor: 11, has_more: false },
  ])
  await syncOnce(net.transport, 'user-1', local.store)
  ok('pull loops while has_more', net.pulls() === 2)
  check('the cursor ends on the last page', local.cursor(), 11)
})()

await (async () => {
  const local = fakeStore(empty())
  const net = fakeTransport(() => [{ changes: echo([]), next_cursor: null, has_more: false }])
  await syncOnce(net.transport, 'user-1', local.store)
  check('an empty page leaves the cursor alone', local.cursor(), 0)
  ok('nothing to push means no request', net.pushed.length === 0)
})()

// ── a failed push must not become a pull ──────────────────────────────────

await (async () => {
  const local = fakeStore(seed)
  let pulled = false
  const transport: Transport = {
    push: async () => { throw new Error('offline') },
    pull: async () => { pulled = true; throw new Error('unreachable') },
  }
  const failed = await syncOnce(transport, 'user-1', local.store).then(() => false, () => true)
  ok('a failed push aborts the run', failed)
  ok('a failed push never pulls over the rows it did not send', !pulled)
  check('a failed push leaves the watermark where it was', local.pushedAt(), -1)
})()

// ── chunking ──────────────────────────────────────────────────────────────

await (async () => {
  const rows = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => ({ id: `r${i + from}`, client_updated_at: i }))
  const chunks = chunkPayload({ decks: rows(3), notes: rows(4, 100) }, 2)
  const flat = chunks.flatMap((c) => [...(c.decks ?? []), ...(c.notes ?? [])])
  check('chunking loses nothing', flat.length, 7)
  ok('no chunk is over the cap',
    chunks.every((c) => (c.decks?.length ?? 0) + (c.notes?.length ?? 0) <= 2))
  check('an empty payload is no requests at all', chunkPayload({}, 2).length, 0)
})()

// Thrown rather than an exit code: `process` needs @types/node, which this app
// does not carry, and a non-zero exit is what both `node file.ts` and
// `node --test` take from it either way.
if (failures) throw new Error(`sync.test.ts: ${failures} check(s) failed`)
console.log('sync.test.ts: ok')
