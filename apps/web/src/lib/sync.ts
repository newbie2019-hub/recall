import type {
  ApiClient, SyncChange, SyncPayload, SyncResourceName, SyncRow,
} from '@recall/core'
import type {
  CardStateLocal, DeckLocal, LocalBatch, MediaLocal, NoteLocal, NoteTypeLocal, ReviewLocal,
} from '../db/queries/sync'
import type * as LocalStore from '../db/queries/sync'

/**
 * The sync loop: push what is unsent, then pull what is new, then stop.
 *
 * Two things are kept out of here on purpose. The SQL is in
 * `db/queries/sync.ts`, and the *store itself* arrives as an argument rather
 * than an import — which is what lets this whole file, mapping and loop
 * included, run in a test with no database and no network. `useSync` is the
 * only place that hands it the real one.
 *
 * Push before pull, always. A pull that landed first could apply a server row
 * over a local edit the server has never seen.
 */

export type Transport = Pick<ApiClient, 'push' | 'pull'>
export type Store = typeof LocalStore

/** Below the server's own MAX_ROWS, so one push is never a 413. */
const PUSH_CHUNK = 400
export const IDLE_MS = 60_000

// ── local ⇄ wire ──────────────────────────────────────────────────────────
//
// The column names differ on both sides and every difference is spelled out
// here, once, in both directions: local `notes.note_type` is the server's
// `note_type_id`, local `reviews.ts` is `client_ts`, local `cards.state_updated_at`
// is the generic `client_updated_at`, and SQLite's 0/1 is JSON's true/false.
// `sync.test.ts` round-trips every one of them.

const str = (v: unknown): string | null => (v == null ? null : String(v))
const bit = (v: unknown): number => (v ? 1 : 0)

/** Tolerant: an import wrote these columns and older rows predate them. */
const json = (raw: string, fallback: unknown): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

const deckUp = (d: DeckLocal): SyncRow => ({
  id: d.id, parent_id: d.parent_id, name: d.name,
  retention_target: d.retention_target, new_per_day: d.new_per_day,
  client_updated_at: d.updated_at,
})

const deckDown = (c: SyncChange): DeckLocal => ({
  id: String(c.id), parent_id: str(c.parent_id), name: String(c.name),
  retention_target: Number(c.retention_target), new_per_day: Number(c.new_per_day),
  updated_at: Number(c.client_updated_at),
})

const noteTypeUp = (t: NoteTypeLocal): SyncRow => ({
  id: t.id, name: t.name,
  fields: json(t.fields, []), templates: json(t.templates, []),
  css: t.css, kind: t.kind, ord_field: t.ord_field, sort_field: t.sort_field,
  field_config: json(t.field_config, []), anki_extra: json(t.anki_extra, {}),
  builtin: !!t.builtin, client_updated_at: t.updated_at,
})

const noteTypeDown = (c: SyncChange): NoteTypeLocal => ({
  id: String(c.id), name: String(c.name),
  fields: JSON.stringify(c.fields ?? []), templates: JSON.stringify(c.templates ?? []),
  css: String(c.css ?? ''), kind: String(c.kind ?? 'standard'), ord_field: str(c.ord_field),
  sort_field: Number(c.sort_field ?? 0),
  field_config: JSON.stringify(c.field_config ?? []),
  anki_extra: JSON.stringify(c.anki_extra ?? {}),
  builtin: bit(c.builtin), updated_at: Number(c.client_updated_at),
})

// `client_created_at` rather than `created_at`: the server's `notes` table has
// Laravel's own `created_at`, and the existing `client_updated_at` is the
// convention for "the client's timestamp, not ours".
const noteUp = (n: NoteLocal): SyncRow => ({
  id: n.id, guid: n.guid, note_type_id: n.note_type, deck_id: n.deck_id,
  fields: json(n.fields, {}), tags: n.tags, fma_id: n.fma_id, checksum: n.checksum,
  client_updated_at: n.updated_at, client_created_at: n.created_at,
})

const noteDown = (c: SyncChange): NoteLocal => ({
  id: String(c.id), guid: String(c.guid), note_type: String(c.note_type_id),
  deck_id: String(c.deck_id), fields: JSON.stringify(c.fields ?? {}),
  tags: String(c.tags ?? ''), fma_id: str(c.fma_id),
  checksum: c.checksum == null ? null : Number(c.checksum),
  updated_at: Number(c.client_updated_at),
  // Rows pushed before migration 10 have no creation time on the server. The
  // modification time is the same fallback the migration backfills with, and
  // it is exact for anything never edited.
  created_at: Number(c.client_created_at ?? c.client_updated_at),
})

/**
 * `card_states`, not `cards`. Eight columns go up and eight come back; `due`,
 * `stability`, `difficulty`, `state`, `reps` and `lapses` are a cache
 * `replayReviews()` rebuilds and are none of the server's business (PHASES §5).
 */
const cardStateUp = (c: CardStateLocal): SyncRow => ({
  id: c.id, note_id: c.note_id, ord: c.ord, suspended: !!c.suspended,
  buried_until: c.buried_until, flag: c.flag, deck_id: c.deck_id,
  original_deck_id: c.original_deck_id,
  due_override: c.due_override, forgotten_at: c.forgotten_at,
  client_updated_at: c.state_updated_at,
})

const cardStateDown = (c: SyncChange): CardStateLocal => ({
  id: String(c.id), note_id: String(c.note_id), ord: Number(c.ord),
  suspended: bit(c.suspended),
  buried_until: c.buried_until == null ? null : Number(c.buried_until),
  flag: Number(c.flag ?? 0), deck_id: str(c.deck_id),
  original_deck_id: str(c.original_deck_id),
  due_override: c.due_override == null ? null : Number(c.due_override),
  forgotten_at: c.forgotten_at == null ? null : Number(c.forgotten_at),
  state_updated_at: Number(c.client_updated_at),
})

// No `client_updated_at`: the log is append-only on both sides, so there is
// nothing for last-write-wins to compare.
const reviewUp = (r: ReviewLocal): SyncRow => ({
  id: r.id, card_id: r.card_id, client_ts: r.ts, rating: r.rating,
  duration_ms: r.duration_ms, imported: !!r.imported,
})

const reviewDown = (c: SyncChange): ReviewLocal => ({
  id: String(c.id), card_id: String(c.card_id), ts: Number(c.client_ts),
  rating: Number(c.rating), duration_ms: Number(c.duration_ms ?? 0),
  imported: bit(c.imported),
})

// Metadata only — the bytes have no endpoint yet, so this says "this device
// holds this file" and nothing more.
const mediaUp = (m: MediaLocal): SyncRow => ({
  sha256: m.sha256, mime: m.mime, size: m.size, client_updated_at: m.created_at,
})

// ── push ──────────────────────────────────────────────────────────────────

export function buildPayload(batch: LocalBatch): SyncPayload {
  const payload: SyncPayload = {}
  const put = (name: SyncResourceName, rows: SyncRow[]) => {
    if (rows.length) payload[name] = rows
  }

  put('decks', batch.decks.map(deckUp))
  put('note_types', batch.note_types.map(noteTypeUp))
  put('notes', batch.notes.map(noteUp))
  put('card_states', batch.card_states.map(cardStateUp))
  put('reviews', batch.reviews.map(reviewUp))
  put('media', batch.media.map(mediaUp))

  // A delete travels as the key plus `deleted`, in the same resource array as
  // the live rows — the server soft-deletes it and every other device learns
  // about it on its next pull, which a hard delete could never tell them.
  for (const t of batch.tombstones) {
    if (t.resource === 'reviews') continue
    const key = t.resource === 'media' ? 'sha256' : 'id'
    ;(payload[t.resource] ??= []).push({
      [key]: t.key, client_updated_at: t.deleted_at, deleted: true,
    })
  }
  return payload
}

/**
 * The high-water mark to remember once this batch is away.
 *
 * Taken from the rows themselves rather than from `Date.now()`: a row written
 * while the push was in flight carries a later `updated_at` and has to stay
 * above the mark, or it would never be sent at all.
 */
export function watermarkOf(batch: LocalBatch, since: number): number {
  return Math.max(
    since,
    ...batch.decks.map((d) => d.updated_at),
    ...batch.note_types.map((t) => t.updated_at),
    ...batch.notes.map((n) => n.updated_at),
    ...batch.card_states.map((c) => c.state_updated_at),
  )
}

/**
 * Split a payload so no single request is oversized.
 *
 * Re-sending a chunk that already landed is free — the keys are client-generated
 * precisely so it is: reviews insert-if-absent, content last-write-wins on an
 * equal timestamp, so nothing here ever invents a key the server has to reconcile.
 */
export function chunkPayload(payload: SyncPayload, max = PUSH_CHUNK): SyncPayload[] {
  const chunks: SyncPayload[] = []
  let current: SyncPayload = {}
  let room = max

  for (const name of Object.keys(payload) as SyncResourceName[]) {
    let rows = payload[name] ?? []
    while (rows.length) {
      const take = rows.slice(0, room)
      current[name] = [...(current[name] ?? []), ...take]
      rows = rows.slice(take.length)
      room -= take.length
      if (room === 0) {
        chunks.push(current)
        current = {}
        room = max
      }
    }
  }
  if (room < max) chunks.push(current)
  return chunks
}

// ── pull ──────────────────────────────────────────────────────────────────

const live = (rows: SyncChange[] | undefined) => (rows ?? []).filter((r) => !r.deleted)
const gone = (rows: SyncChange[] | undefined, key = 'id') =>
  (rows ?? []).filter((r) => r.deleted).map((r) => String(r[key]))

/**
 * Apply one pulled page.
 *
 * Order is dependency order, because the local schema has foreign keys on: a
 * note needs its deck, a card state needs its note. The server's single revision
 * counter already orders the *pages* the same way, which is what makes one cursor
 * across six tables enough.
 *
 * Deletes go last and in reverse, so a deck that lost its notes in the same page
 * does not cascade over rows this page still had to insert.
 */
export async function applyChanges(
  changes: Partial<Record<SyncResourceName, SyncChange[]>>,
  local: Store,
): Promise<void> {
  await local.putDecks(live(changes.decks).map(deckDown))
  await local.putNoteTypes(live(changes.note_types).map(noteTypeDown))
  await local.putNotes(live(changes.notes).map(noteDown))
  await local.putCardStates(live(changes.card_states).map(cardStateDown))
  // Last: a pulled review is history, and replaying it needs the note and the
  // deck it belongs to already in place.
  await local.putReviews((changes.reviews ?? []).map(reviewDown))

  await local.remove('card_states', gone(changes.card_states))
  await local.remove('notes', gone(changes.notes))
  await local.remove('note_types', gone(changes.note_types))
  await local.remove('decks', gone(changes.decks))
}

// ── the loop ──────────────────────────────────────────────────────────────

export async function syncOnce(
  client: Transport,
  userId: string,
  local: Store,
): Promise<void> {
  // First, because it may reset the cursor and the watermark we are about to read.
  await local.adoptInto(userId)
  const state = await local.readState()

  const batch = await local.collectLocal(state.pushedAt)
  const chunks = chunkPayload(buildPayload(batch))
  if (chunks.length) {
    // A chunk that throws aborts the whole run *including the pull*. Advancing
    // past rows the server never received would let its older copy come back
    // down and overwrite them.
    for (const chunk of chunks) await client.push(chunk)
    await local.markPushed(batch, watermarkOf(batch, state.pushedAt))
  }

  let cursor = state.cursor
  for (;;) {
    const page = await client.pull(cursor)
    await applyChanges(page.changes, local)
    if (page.next_cursor === null) break
    cursor = page.next_cursor
    // Only now. A cursor advanced before its rows were committed skips them for
    // good — the next pull starts above them and nothing ever asks again.
    await local.writeCursor(cursor)
    if (!page.has_more) break
  }
}

/** One minute when healthy, doubling to a quarter of an hour while it is not. */
export const backoffMs = (failures: number): number =>
  Math.min(15 * IDLE_MS, IDLE_MS * 2 ** Math.max(0, failures - 1))

let inFlight: Promise<boolean> | null = null

/**
 * A run that never throws and never leaves two loops racing.
 *
 * Coalesced because the timer, the reconnect handler and the
 * hidden-tab handler can all fire within the same second, and two loops pushing
 * the same rows is double the traffic for the same result. A failure reports
 * itself to the banner and is otherwise ignored: nothing local is rolled back,
 * nothing is deleted, and every unsent row is still unsent for the next attempt.
 */
export function sync(
  client: Transport,
  userId: string,
  local: Store,
  report: (ok: boolean) => void,
): Promise<boolean> {
  return (inFlight ??= syncOnce(client, userId, local)
    .then(() => true)
    .catch((e: unknown) => {
      console.warn('sync failed', e)
      return false
    })
    .then((ok) => {
      inFlight = null
      report(ok)
      return ok
    }))
}
