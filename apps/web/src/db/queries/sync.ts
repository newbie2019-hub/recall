import { newCard, replayReviews, type Review, type SyncResourceName } from '@recall/core'
import { db } from '../client'
import { saveNote } from '../repo'

/**
 * Every statement the sync loop runs against the local collection.
 *
 * It speaks **local rows only** — `notes.note_type`, `cards.state_updated_at`,
 * tags as one space-joined string. The translation to and from the wire lives in
 * `lib/sync.ts`, which is what lets the loop be tested without a database and
 * this file be read without a network.
 */

const KEY_CURSOR = 'cursor'
const KEY_USER = 'user_id'
const KEY_PUSHED = 'pushed_at'

const PUT_STATE = `INSERT INTO sync_state (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value`

/** SQLite's default parameter ceiling is 999; ids arrive in thousands after an import. */
const chunked = <T>(xs: T[], size = 400): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size))
  return out
}

const holes = (n: number) => Array.from({ length: n }, () => '?').join(',')

// ── local row shapes ──────────────────────────────────────────────────────

export interface DeckLocal {
  id: string; parent_id: string | null; name: string
  retention_target: number; new_per_day: number; updated_at: number
}

export interface NoteTypeLocal {
  id: string; name: string; fields: string; templates: string; css: string
  kind: string; ord_field: string | null; sort_field: number
  field_config: string; anki_extra: string; builtin: number; updated_at: number
}

export interface NoteLocal {
  id: string; guid: string; note_type: string; deck_id: string
  fields: string; tags: string; fma_id: string | null
  checksum: number | null; updated_at: number
}

export interface CardStateLocal {
  id: string; note_id: string; ord: number; suspended: number
  buried_until: number | null; flag: number; deck_id: string | null
  state_updated_at: number
}

export interface ReviewLocal {
  id: string; card_id: string; ts: number; rating: number
  duration_ms: number; imported: number
}

export interface MediaLocal { sha256: string; mime: string; size: number; created_at: number }

export interface TombstoneLocal { resource: SyncResourceName; key: string; deleted_at: number }

export interface LocalBatch {
  decks: DeckLocal[]
  note_types: NoteTypeLocal[]
  notes: NoteLocal[]
  card_states: CardStateLocal[]
  reviews: ReviewLocal[]
  media: MediaLocal[]
  tombstones: TombstoneLocal[]
}

// ── bookkeeping ───────────────────────────────────────────────────────────

export interface SyncState {
  /** The server's per-user revision counter, not a clock. */
  cursor: number
  userId: string | null
  /** High-water mark over `updated_at`: everything above it is unpushed. */
  pushedAt: number
}

export async function readState(): Promise<SyncState> {
  const rows = await db.select<{ key: string; value: string | null }>(
    'SELECT key, value FROM sync_state',
  )
  const at = (k: string) => rows.find((r) => r.key === k)?.value ?? null
  return {
    cursor: Number(at(KEY_CURSOR) ?? 0),
    userId: at(KEY_USER),
    // -1 rather than 0: migration 7 seeded `updated_at` to 0 on every deck and
    // note type that already existed, and a `> 0` watermark would leave all of
    // them unsyncable for the life of the collection.
    pushedAt: Number(at(KEY_PUSHED) ?? -1),
  }
}

export const writeCursor = (cursor: number): Promise<void> =>
  db.run(PUT_STATE, [KEY_CURSOR, String(cursor)])

/**
 * Point the collection at an account, adopting whatever is already here.
 *
 * PHASES §5 settled this: signing into account B on a device holding account A's
 * rows donates them to B. So everything is marked unsent again — B's server has
 * none of it — and the cursor restarts, because revisions are per account and A's
 * numbering means nothing to B.
 *
 * The `UPDATE reviews` is not a breach of the append-only rule: `synced` is
 * delivery bookkeeping, not history. No rating, timestamp or id is touched.
 */
export async function adoptInto(userId: string): Promise<void> {
  const held = await readState()
  if (held.userId === userId) return
  await db.batch([
    { sql: PUT_STATE, params: [KEY_USER, userId] },
    { sql: PUT_STATE, params: [KEY_CURSOR, '0'] },
    { sql: PUT_STATE, params: [KEY_PUSHED, '-1'] },
    { sql: 'UPDATE reviews SET synced = 0' },
    { sql: 'UPDATE media SET synced = 0' },
    { sql: 'UPDATE tombstones SET synced = 0' },
  ])
}

// ── reading what is unsent ────────────────────────────────────────────────

export async function collectLocal(since: number): Promise<LocalBatch> {
  const [decks, note_types, notes, card_states, reviews, media, tombstones] = await Promise.all([
    db.select<DeckLocal>(
      `SELECT id, parent_id, name, retention_target, new_per_day, updated_at
         FROM decks WHERE updated_at > ?`, [since],
    ),
    db.select<NoteTypeLocal>(
      `SELECT id, name, fields, templates, css, kind, ord_field, sort_field,
              field_config, anki_extra, builtin, updated_at
         FROM note_types WHERE updated_at > ?`, [since],
    ),
    db.select<NoteLocal>(
      `SELECT id, guid, note_type, deck_id, fields, tags, fma_id, checksum, updated_at
         FROM notes WHERE updated_at > ?`, [since],
    ),
    // `cards`, but only the columns a person decided. due/stability/state are a
    // derived cache and are not the server's business (PHASES §5).
    db.select<CardStateLocal>(
      `SELECT id, note_id, ord, suspended, buried_until, flag, deck_id, state_updated_at
         FROM cards WHERE state_updated_at > ?`, [since],
    ),
    db.select<ReviewLocal>(
      `SELECT id, card_id, ts, rating, duration_ms, imported FROM reviews WHERE synced = 0`,
    ),
    db.select<MediaLocal>(`SELECT sha256, mime, size, created_at FROM media WHERE synced = 0`),
    db.select<TombstoneLocal>(
      `SELECT resource, key, deleted_at FROM tombstones WHERE synced = 0`,
    ),
  ])
  return { decks, note_types, notes, card_states, reviews, media, tombstones }
}

/**
 * Everything in `batch` reached the server.
 *
 * Reviews and media are marked by id rather than with a blanket
 * `WHERE synced = 0`: a review answered while the push was in flight would
 * otherwise be marked sent without ever having been, and that row is the one
 * thing in the product nothing else can rebuild.
 */
export async function markPushed(batch: LocalBatch, pushedAt: number): Promise<void> {
  const stmts: { sql: string; params?: unknown[] }[] = [
    { sql: PUT_STATE, params: [KEY_PUSHED, String(pushedAt)] },
  ]
  for (const ids of chunked(batch.reviews.map((r) => r.id)))
    stmts.push({ sql: `UPDATE reviews SET synced = 1 WHERE id IN (${holes(ids.length)})`, params: ids })
  for (const keys of chunked(batch.media.map((m) => m.sha256)))
    stmts.push({ sql: `UPDATE media SET synced = 1 WHERE sha256 IN (${holes(keys.length)})`, params: keys })
  for (const t of batch.tombstones)
    stmts.push({
      sql: 'UPDATE tombstones SET synced = 1 WHERE resource = ? AND key = ?',
      params: [t.resource, t.key],
    })
  await db.batch(stmts)
}

// ── applying what was pulled ──────────────────────────────────────────────

const PUT_DECK = `INSERT INTO decks (id, parent_id, name, retention_target, new_per_day, updated_at)
  VALUES (?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET
    parent_id = excluded.parent_id, name = excluded.name,
    retention_target = excluded.retention_target, new_per_day = excluded.new_per_day,
    updated_at = excluded.updated_at
  WHERE excluded.updated_at > decks.updated_at`

/**
 * `filtered`, `filter_config` and the marketplace columns are deliberately
 * absent from both lists: the server does not carry them (SyncResource::writable),
 * so naming them here would blank a filtered deck every time it syncs.
 */
export async function putDecks(rows: DeckLocal[]): Promise<void> {
  for (const d of rows) {
    const params: unknown[] = [d.id, d.parent_id, d.name, d.retention_target, d.new_per_day, d.updated_at]
    try {
      await db.run(PUT_DECK, params)
    } catch (e) {
      if (!/UNIQUE|constraint/i.test(String(e))) throw e
      // Two devices that each seeded a "Default" deck collide on the sibling
      // unique index (migration 4) — which is the *first* thing that happens on a
      // second device, not an edge case. Migration 4's own answer applies: a deck
      // the user has to rename beats a sync that is stuck forever. `Date.now()`
      // makes the rename win the next push, so the devices converge on it instead
      // of colliding again on every pull.
      params[2] = `${d.name} (${d.id.slice(0, 4)})`
      params[5] = Date.now()
      await db.run(PUT_DECK, params)
    }
  }
}

const PUT_NOTE_TYPE = `INSERT INTO note_types
    (id, name, fields, templates, css, kind, ord_field, sort_field, field_config,
     anki_extra, builtin, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name, fields = excluded.fields, templates = excluded.templates,
    css = excluded.css, kind = excluded.kind, ord_field = excluded.ord_field,
    sort_field = excluded.sort_field, field_config = excluded.field_config,
    anki_extra = excluded.anki_extra, builtin = excluded.builtin,
    updated_at = excluded.updated_at
  WHERE excluded.updated_at > note_types.updated_at`

export const putNoteTypes = (rows: NoteTypeLocal[]): Promise<void> =>
  db.batch(rows.map((t) => ({
    sql: PUT_NOTE_TYPE,
    params: [t.id, t.name, t.fields, t.templates, t.css, t.kind, t.ord_field,
             t.sort_field, t.field_config, t.anki_extra, t.builtin, t.updated_at],
  })))

/**
 * A pulled note goes through `saveNote`, not through an INSERT.
 *
 * Its fields decide **which cards should exist**: empty the reverse field on one
 * device and card 2 has to stop existing on the other, fill it back in and the
 * card has to come back and replay its own history. `saveNote` is the single
 * place that reconciles that, and writing the row directly here would leave the
 * card set silently wrong until somebody edited the note by hand.
 *
 * ponytail: one round trip per note, plus `saveNote`'s own note-type lookup. A
 * 500-row page is 1,500 worker calls. Batch it if a first sync of a large
 * collection turns out to be slow enough to notice.
 */
export async function putNotes(rows: NoteLocal[]): Promise<void> {
  if (!rows.length) return

  // The server has already applied last-write-wins, but a push that failed part
  // way leaves local edits it has never seen — and an older pulled row must not
  // eat them.
  const held = new Map<string, number>()
  for (const ids of chunked(rows.map((n) => n.id)))
    for (const r of await db.select<{ id: string; updated_at: number }>(
      `SELECT id, updated_at FROM notes WHERE id IN (${holes(ids.length)})`, ids,
    )) held.set(r.id, r.updated_at)

  for (const n of rows) {
    if ((held.get(n.id) ?? -1) >= n.updated_at) continue
    await saveNote({
      id: n.id,
      guid: n.guid,
      noteTypeId: n.note_type,
      deckId: n.deck_id,
      fields: JSON.parse(n.fields) as Record<string, string>,
      tags: n.tags ? n.tags.split(' ') : [],
      fmaId: n.fma_id,
    }, n.updated_at)
  }
}

/**
 * The `DO UPDATE` list is the whole point: it names `suspended`, `buried_until`,
 * `flag` and `deck_id` and nothing else, so a pulled row can never overwrite the
 * FSRS cache in the same table. The VALUES carry a fresh card only for the insert
 * case — a card state can arrive for a card this device has not generated yet.
 */
const PUT_CARD_STATE = `INSERT INTO cards
    (id, note_id, ord, due, stability, difficulty, state, learning_steps, reps,
     lapses, last_review, suspended, buried_until, flag, deck_id, state_updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET
    suspended = excluded.suspended, buried_until = excluded.buried_until,
    flag = excluded.flag, deck_id = excluded.deck_id,
    state_updated_at = excluded.state_updated_at
  WHERE excluded.state_updated_at > cards.state_updated_at`

export const putCardStates = (rows: CardStateLocal[]): Promise<void> =>
  db.batch(rows.map((c) => {
    const fresh = newCard(c.id, c.note_id, c.ord, c.state_updated_at)
    return {
      sql: PUT_CARD_STATE,
      params: [c.id, c.note_id, c.ord, fresh.due, fresh.stability, fresh.difficulty,
               fresh.state, fresh.learning_steps, fresh.reps, fresh.lapses, fresh.last_review,
               c.suspended, c.buried_until, c.flag, c.deck_id, c.state_updated_at],
    }
  }))

/**
 * Pulled reviews land in the log and the cards they touch are replayed.
 *
 * `synced = 1`: they came *from* the server, and pushing them back would be this
 * device claiming somebody else's answers. `DO NOTHING` makes a repeated pull
 * free, which is what keeps the log honest about how much studying happened.
 */
export async function putReviews(rows: ReviewLocal[]): Promise<void> {
  if (!rows.length) return
  await db.batch(rows.map((r) => ({
    sql: `INSERT INTO reviews (id, card_id, ts, rating, duration_ms, synced, imported)
          VALUES (?,?,?,?,?,1,?) ON CONFLICT(id) DO NOTHING`,
    params: [r.id, r.card_id, r.ts, r.rating, r.duration_ms, r.imported],
  })))
  await replayCards([...new Set(rows.map((r) => r.card_id))])
}

const UPDATE_CARD = `UPDATE cards SET due=?, stability=?, difficulty=?, state=?,
  learning_steps=?, reps=?, lapses=?, last_review=? WHERE id=?`

/**
 * Rebuild the derived cache for cards whose history just changed.
 *
 * A card with no row here is skipped rather than created: the note that
 * generates it has not been pulled yet, and `saveNote` replays the log into it
 * the moment it arrives.
 */
async function replayCards(cardIds: string[]): Promise<void> {
  for (const ids of chunked(cardIds)) {
    const meta = await db.select<{ id: string; note_id: string; ord: number; retention_target: number }>(
      `SELECT c.id, c.note_id, c.ord, d.retention_target
         FROM cards c
         JOIN notes n ON n.id = c.note_id
         JOIN decks d ON d.id = COALESCE(c.deck_id, n.deck_id)
        WHERE c.id IN (${holes(ids.length)})`, ids,
    )
    if (!meta.length) continue
    const log = await db.select<Review>(
      `SELECT * FROM reviews WHERE card_id IN (${holes(ids.length)}) ORDER BY ts`, ids,
    )
    await db.batch(meta.map((m) => {
      const own = log.filter((r) => r.card_id === m.id)
      const card = replayReviews(
        { id: m.id, note_id: m.note_id, ord: m.ord },
        own, m.retention_target, own[0]?.ts ?? Date.now(),
      )
      return {
        sql: UPDATE_CARD,
        params: [card.due, card.stability, card.difficulty, card.state,
                 card.learning_steps, card.reps, card.lapses, card.last_review, card.id],
      }
    }))
  }
}

/**
 * A pulled `deleted: true`.
 *
 * Deliberately *not* routed through `repo.deleteNote`/`deleteDeck`: once those
 * write tombstones, a delete that came from the server would bounce straight back
 * up as a delete of our own, burning a revision and waking every other device.
 * `note_types` also skips `repo.deleteNoteType`, which refuses while notes still
 * use the type — those notes carry their own tombstones, possibly on a later
 * page, and refusing here would wedge the sync until they arrived.
 */
export async function remove(resource: SyncResourceName, keys: string[]): Promise<void> {
  // Media is content-addressed and its bytes are local-only until there is an
  // upload endpoint, so a server-side delete has nothing to act on here.
  if (!keys.length || resource === 'reviews' || resource === 'media') return

  for (const ids of chunked(keys)) {
    const q = holes(ids.length)
    const stmts: { sql: string; params?: unknown[] }[] = []
    if (resource === 'decks') {
      // Cards borrowed into this subtree by a template override are released
      // first, so nothing is left pointing at a deck that stops existing.
      stmts.push({
        sql: `WITH RECURSIVE sub(id) AS (
                SELECT id FROM decks WHERE id IN (${q})
                UNION SELECT d.id FROM decks d JOIN sub ON d.parent_id = sub.id
              )
              UPDATE cards SET deck_id = NULL WHERE deck_id IN (SELECT id FROM sub)`,
        params: ids,
      })
      stmts.push({ sql: `DELETE FROM decks WHERE id IN (${q})`, params: ids })
    } else if (resource === 'notes') {
      stmts.push({ sql: `DELETE FROM cards WHERE note_id IN (${q})`, params: ids })
      stmts.push({ sql: `DELETE FROM notes WHERE id IN (${q})`, params: ids })
    } else if (resource === 'note_types') {
      stmts.push({ sql: `DELETE FROM note_types WHERE id IN (${q})`, params: ids })
    } else {
      stmts.push({ sql: `DELETE FROM cards WHERE id IN (${q})`, params: ids })
    }
    await db.batch(stmts)
  }
}
