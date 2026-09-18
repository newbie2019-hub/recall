import { db } from '@/db/client'

/**
 * Everything the settings screens read or write in the collection.
 *
 * Preferences live in `sync_state`, the kv table migration 7 added for exactly
 * this reason — "a kv row is the one shape that never needs a migration when a
 * sixth thing has to be remembered". Keys are prefixed `pref.` so a person's
 * choices stay distinguishable from the sync loop's own bookkeeping (cursor,
 * device id) in the same table.
 *
 * The theme is deliberately *not* here: it has to be applied before the first
 * paint and this database is async and behind a worker. See `lib/theme.ts`.
 */

async function prefs(prefix: string): Promise<Map<string, string>> {
  const rows = await db.select<{ key: string; value: string | null }>(
    'SELECT key, value FROM sync_state WHERE key LIKE ?',
    [`${prefix}%`],
  )
  return new Map(rows.filter((r) => r.value !== null).map((r) => [r.key, r.value as string]))
}

const setPref = (key: string, value: string) =>
  db.run('INSERT INTO sync_state (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
    key,
    value,
  ])

// ── scheduling defaults ───────────────────────────────────────────────────

export interface SchedulingDefaults {
  retention: number
  newPerDay: number
}

/** The literals `repo.createDeck` writes today, and the fallback if nothing is stored. */
export const FACTORY_DEFAULTS: SchedulingDefaults = { retention: 0.9, newPerDay: 20 }

export async function schedulingDefaults(): Promise<SchedulingDefaults> {
  const stored = await prefs('pref.scheduling.')
  const retention = Number(stored.get('pref.scheduling.retention'))
  const newPerDay = Number(stored.get('pref.scheduling.new_per_day'))
  return {
    retention: Number.isFinite(retention) && retention > 0 ? retention : FACTORY_DEFAULTS.retention,
    newPerDay: Number.isFinite(newPerDay) && newPerDay >= 0 ? newPerDay : FACTORY_DEFAULTS.newPerDay,
  }
}

/**
 * Clamped the same way `repo.setDeckOptions` clamps a single deck's values — a
 * default that a per-deck edit would refuse is a default that produces decks
 * nobody can save.
 */
export async function setSchedulingDefaults(retention: number, newPerDay: number): Promise<void> {
  await Promise.all([
    setPref('pref.scheduling.retention', String(Math.min(0.99, Math.max(0.7, retention)))),
    setPref('pref.scheduling.new_per_day', String(Math.min(9999, Math.max(0, Math.round(newPerDay) || 0)))),
  ])
}

// ── per-deck offline opt-in ───────────────────────────────────────────────

/**
 * ponytail: this records the choice and nothing evicts on it yet. Media is a
 * BLOB in the same SQLite file as the notes, so opting a deck out cannot free a
 * byte until the Workbox service worker and the media sync (both Phase 5, both
 * unbuilt) are the ones deciding what to keep. The flag is the contract they
 * read; until then the switch is a promise about the next sync, not this one.
 */
const OFFLINE = 'pref.offline.'

/**
 * Only the decks somebody has had an opinion about. A missing row means "keep
 * it", because today the whole collection is local and a default of "off" would
 * describe a state no device is actually in.
 */
export async function offlineDecks(): Promise<Map<string, boolean>> {
  const stored = await prefs(OFFLINE)
  return new Map([...stored].map(([k, v]) => [k.slice(OFFLINE.length), v === '1']))
}

export const setDeckOffline = (deckId: string, keep: boolean) =>
  setPref(`${OFFLINE}${deckId}`, keep ? '1' : '0')

// ── what is on this device ────────────────────────────────────────────────

export interface DeckSize {
  id: string
  parent_id: string | null
  name: string
  notes: number
  cards: number
  bytes: number
}

/**
 * Per-deck row counts and the media those rows reference.
 *
 * Cards are attributed with `COALESCE(c.deck_id, n.deck_id)` like every other
 * deck-scoped query, because a template override sends a card to another deck
 * and counting it twice would contradict the deck badge (rule 4). Media is
 * attributed to the *note's* deck, and an image pasted into two decks is
 * counted in both — the screen says "estimate" for that reason.
 *
 * ponytail: the media join is an O(notes × media) `instr` scan, because the
 * sha is embedded in a JSON field rather than stored in a join table. Fine for
 * a settings screen on a personal collection; add a `note_media` table when
 * someone with 50k notes waits on it.
 */
export function deckSizes(): Promise<DeckSize[]> {
  return db.select<DeckSize>(`
    WITH
      n AS (SELECT deck_id, COUNT(*) AS notes FROM notes GROUP BY deck_id),
      c AS (
        SELECT COALESCE(c.deck_id, n.deck_id) AS deck_id, COUNT(*) AS cards
          FROM cards c JOIN notes n ON n.id = c.note_id
         GROUP BY 1
      ),
      m AS (
        SELECT n.deck_id AS deck_id, SUM(md.size) AS bytes
          FROM notes n JOIN media md ON instr(n.fields, md.sha256) > 0
         GROUP BY 1
      )
    SELECT d.id, d.parent_id, d.name,
           COALESCE(n.notes, 0) AS notes,
           COALESCE(c.cards, 0) AS cards,
           COALESCE(m.bytes, 0) AS bytes
      FROM decks d
      LEFT JOIN n ON n.deck_id = d.id
      LEFT JOIN c ON c.deck_id = d.id
      LEFT JOIN m ON m.deck_id = d.id
     ORDER BY d.name`)
}

export interface CollectionCounts {
  decks: number
  notes: number
  cards: number
  reviews: number
  unsynced: number
  media: number
  mediaBytes: number
}

/** The numbers every destructive dialog has to show before it offers a button. */
export async function collectionCounts(): Promise<CollectionCounts> {
  const [row] = await db.select<CollectionCounts>(`
    SELECT (SELECT COUNT(*) FROM decks)   AS decks,
           (SELECT COUNT(*) FROM notes)   AS notes,
           (SELECT COUNT(*) FROM cards)   AS cards,
           (SELECT COUNT(*) FROM reviews) AS reviews,
           (SELECT COUNT(*) FROM reviews WHERE synced = 0) AS unsynced,
           (SELECT COUNT(*) FROM media)   AS media,
           (SELECT COALESCE(SUM(size), 0) FROM media) AS mediaBytes`)
  return row ?? { decks: 0, notes: 0, cards: 0, reviews: 0, unsynced: 0, media: 0, mediaBytes: 0 }
}

/** Reviews this device has never managed to send. Sign-out has to say this number. */
export async function unsyncedReviewCount(): Promise<number> {
  const [row] = await db.select<{ n: number }>('SELECT COUNT(*) AS n FROM reviews WHERE synced = 0')
  return row?.n ?? 0
}

// ── the one destructive path ──────────────────────────────────────────────

/**
 * Erase the local collection. Only ever from a dialog that has shown the counts
 * above and taken a typed confirmation.
 *
 * Rule 1 forbids `UPDATE`/`DELETE` on `reviews` because scheduling state is
 * derived from that log and rewriting it is a lie. This is the single exception
 * in the app: the person is not editing history, they are asking for the whole
 * collection to be gone from this device. Nothing else may delete from it.
 *
 * Two things this deliberately does *not* do. It writes **no tombstones** — a
 * local wipe is not a deletion of the account's data, and tombstones would push
 * up and delete the same rows on every other device. And it clears `sync_state`
 * with everything else, because a surviving cursor would tell the next sign-in
 * "you are already up to date" and leave the collection permanently empty.
 */
export function eraseLocalCollection(): Promise<void> {
  return db.batch([
    // Children first: foreign keys are declared on these tables.
    { sql: 'DELETE FROM reviews' },
    { sql: 'DELETE FROM cards' },
    { sql: 'DELETE FROM notes' },
    { sql: 'DELETE FROM pomodoro_sessions' },
    { sql: 'DELETE FROM decks' },
    { sql: 'DELETE FROM media' },
    { sql: 'DELETE FROM note_types' },
    { sql: 'DELETE FROM tombstones' },
    { sql: 'DELETE FROM sync_state' },
  ])
}
