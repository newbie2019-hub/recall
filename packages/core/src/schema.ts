/**
 * Migrations, applied in order against PRAGMA user_version.
 * Append only - never edit a shipped migration, add a new one.
 * Keep the SQL portable: the same statements run on sqlite-wasm (web),
 * op-sqlite (React Native), and are mirrored by Laravel migrations for MySQL.
 */
export const MIGRATIONS: string[] = [
  // 1
  `
  CREATE TABLE decks (
    id               TEXT PRIMARY KEY,
    parent_id        TEXT REFERENCES decks(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    retention_target REAL NOT NULL DEFAULT 0.9,
    new_per_day      INTEGER NOT NULL DEFAULT 20
  );
  CREATE INDEX idx_decks_parent ON decks(parent_id);

  CREATE TABLE notes (
    id         TEXT PRIMARY KEY,
    note_type  TEXT NOT NULL,
    deck_id    TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    fields     TEXT NOT NULL,          -- JSON: field name -> value
    tags       TEXT NOT NULL DEFAULT '',
    fma_id     TEXT,                   -- Foundational Model of Anatomy concept
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX idx_notes_deck ON notes(deck_id);
  CREATE INDEX idx_notes_fma  ON notes(fma_id);

  -- Derived cache. Rebuildable from reviews via replayReviews().
  CREATE TABLE cards (
    id           TEXT PRIMARY KEY,
    note_id      TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    ord          INTEGER NOT NULL DEFAULT 0,
    due          INTEGER NOT NULL,
    stability    REAL NOT NULL DEFAULT 0,
    difficulty   REAL NOT NULL DEFAULT 0,
    state        TEXT NOT NULL DEFAULT 'new',
    learning_steps INTEGER NOT NULL DEFAULT 0,
    reps         INTEGER NOT NULL DEFAULT 0,
    lapses       INTEGER NOT NULL DEFAULT 0,
    last_review  INTEGER,
    suspended    INTEGER NOT NULL DEFAULT 0,
    buried_until INTEGER,
    flag         INTEGER NOT NULL DEFAULT 0,
    UNIQUE (note_id, ord)
  );
  CREATE INDEX idx_cards_due ON cards(due) WHERE suspended = 0;

  -- APPEND ONLY. No UPDATE, no DELETE, ever.
  CREATE TABLE reviews (
    id          TEXT PRIMARY KEY,
    card_id     TEXT NOT NULL,
    ts          INTEGER NOT NULL,
    rating      INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    synced      INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_reviews_card   ON reviews(card_id, ts);
  CREATE INDEX idx_reviews_unsent ON reviews(synced) WHERE synced = 0;
  `,

  // 2 - note types and media (Phase 2)
  `
  -- Built-ins are written from BUILTIN_NOTE_TYPES on boot; imported Anki types
  -- land in the same table so there is exactly one rendering path (PLAN.md §0).
  CREATE TABLE note_types (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    fields     TEXT NOT NULL,          -- JSON: string[]
    templates  TEXT NOT NULL,          -- JSON: { name, qfmt, afmt }[]
    css        TEXT NOT NULL DEFAULT '',
    kind       TEXT NOT NULL DEFAULT 'standard',
    ord_field  TEXT,
    builtin    INTEGER NOT NULL DEFAULT 0
  );

  -- Content-addressed, so the same image pasted into twenty notes is stored
  -- once and an interrupted upload resumes rather than restarts (PLAN.md §2.6).
  CREATE TABLE media (
    sha256     TEXT PRIMARY KEY,
    mime       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    bytes      BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,

  // 3 - note identity, deck override, note type extras (CARDS.md §8)
  `
  -- A note's identity for the life of the collection and beyond it. Anki
  -- matches notes on import by guid, so without one a re-import of an updated
  -- shared deck inserts a second copy of everything, and decks we export can
  -- never be updated by anyone either.
  ALTER TABLE notes ADD COLUMN guid TEXT;
  UPDATE notes SET guid = lower(hex(randomblob(8))) WHERE guid IS NULL;
  CREATE UNIQUE INDEX idx_notes_guid ON notes(guid);

  -- Ours, for the duplicate warning while adding. NOT Anki's csum - import
  -- matches on guid, never on this.
  ALTER TABLE notes ADD COLUMN checksum INTEGER;
  CREATE INDEX idx_notes_dupe ON notes(note_type, checksum);

  ALTER TABLE note_types ADD COLUMN sort_field INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE note_types ADD COLUMN field_config TEXT NOT NULL DEFAULT '[]';
  -- latexPre/latexPost/bqfmt/bafmt/originalStockKind, carried opaque so a
  -- round-trip through us does not degrade somebody's deck.
  ALTER TABLE note_types ADD COLUMN anki_extra TEXT NOT NULL DEFAULT '{}';

  -- Template deck override: a template can send its cards elsewhere.
  -- NULL means "follow the note", which is every card until an import says
  -- otherwise. Every deck-scoped query reads COALESCE(c.deck_id, n.deck_id).
  ALTER TABLE cards ADD COLUMN deck_id TEXT REFERENCES decks(id);
  `,

  // 4 - sibling deck names are unique
  `
  -- Two decks with the same name under the same parent are indistinguishable
  -- to a person and *ambiguous to the importer*: an Anki path like
  -- "Anatomy::Heart" has to resolve to exactly one deck, or a re-import lands
  -- its notes in whichever row the query happened to return first.
  --
  -- Existing collisions are renamed rather than dropped, and the rename is
  -- visible: a deck the user has to fix beats a deck that silently vanished.
  UPDATE decks SET name = name || ' ' || (
    SELECT COUNT(*) FROM decks e
     WHERE e.name = decks.name
       AND e.parent_id IS decks.parent_id
       AND e.rowid < decks.rowid
  ) + 1
  WHERE EXISTS (
    SELECT 1 FROM decks e
     WHERE e.name = decks.name
       AND e.parent_id IS decks.parent_id
       AND e.rowid < decks.rowid
  );

  -- COALESCE, not the bare column: NULLs compare distinct in a unique index,
  -- so without it two root decks could still share a name.
  CREATE UNIQUE INDEX idx_decks_sibling ON decks(COALESCE(parent_id, ''), name);
  `,

  // 5 - imported review history is not the user's last answer (Phase 4)
  `
  -- Undo removes the most recent unsynced review, which is right for a
  -- mis-click and catastrophic for an import: the newest row in the log is now
  -- somebody's 2019 answer, arriving today. Imported rows are still unsynced,
  -- because Phase 5 has to send them; they are just not undoable.
  ALTER TABLE reviews ADD COLUMN imported INTEGER NOT NULL DEFAULT 0;
  `,

  // 6 - every note has a guid, including the ones the seeder wrote
  `
  -- Migration 3 backfilled the notes that existed *then*. The seeder ran after
  -- it and inserted without one, so a collection created since has notes with a
  -- NULL guid — which export rejects and re-import cannot match. Same repair,
  -- run once more, and the seeder now mints its own.
  UPDATE notes SET guid = lower(hex(randomblob(8))) WHERE guid IS NULL;
  `,

  // 7 - everything phases 5-8 write against (sync, pomodoro, filtered decks,
  //     marketplace). Written in one migration, before those phases are built,
  //     because five parallel workstreams each appending their own migration is
  //     how a collection ends up on a different user_version per developer.
  `
  -- Sync bookkeeping. A kv table rather than columns on a singleton row: the
  -- cursor, the device id and the signed-in user are read and written
  -- independently, and a kv row is the one shape that never needs a migration
  -- when a sixth thing has to be remembered.
  CREATE TABLE sync_state (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  -- A hard delete is invisible to a device that was offline when it happened,
  -- and the row comes back on that device's next push. Mirrors the server's
  -- tombstones (PHASES §5). Dropped once every device has moved past them.
  CREATE TABLE tombstones (
    resource   TEXT NOT NULL,
    key        TEXT NOT NULL,
    deleted_at INTEGER NOT NULL,
    synced     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (resource, key)
  );
  CREATE INDEX idx_tombstones_unsent ON tombstones(synced) WHERE synced = 0;

  -- Last-write-wins needs a clock on every syncable row, not just notes.
  -- Seeded to 0 rather than now(): a row that has never been edited must lose
  -- to anything the server holds, and now() would make it win.
  ALTER TABLE decks      ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE note_types ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
  -- cards is a derived cache, but the card_states *subset* - suspended,
  -- buried_until, flag, deck_id - is what a person decided, so it syncs and
  -- needs its own clock (PHASES §5, "card_states, not cards").
  ALTER TABLE cards      ADD COLUMN state_updated_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE media      ADD COLUMN synced INTEGER NOT NULL DEFAULT 0;

  -- Phase 6. Logged beside reviews so focus blocks can be correlated with
  -- accuracy; ended_at NULL means a block still running.
  CREATE TABLE pomodoro_sessions (
    id         TEXT PRIMARY KEY,
    deck_id    TEXT REFERENCES decks(id) ON DELETE SET NULL,
    kind       TEXT NOT NULL DEFAULT 'focus',   -- focus | break
    started_at INTEGER NOT NULL,
    ended_at   INTEGER,
    planned_ms INTEGER NOT NULL
  );
  CREATE INDEX idx_pomodoro_started ON pomodoro_sessions(started_at);

  -- Leeches and sibling burying, per deck because the right answer differs by
  -- material: burying siblings is the point on a reversed language deck and
  -- merely annoying on a deck of unrelated facts. Defaults are Anki's, so a
  -- collection that never opens deck options behaves the way people expect.
  ALTER TABLE decks ADD COLUMN leech_threshold INTEGER NOT NULL DEFAULT 8;
  ALTER TABLE decks ADD COLUMN leech_action    TEXT    NOT NULL DEFAULT 'suspend';
  ALTER TABLE decks ADD COLUMN bury_new        INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE decks ADD COLUMN bury_reviews    INTEGER NOT NULL DEFAULT 1;

  -- Per-deck, because a language deck is worth hearing and a pharmacology deck
  -- is not. Default off: an app that makes noise unprompted gets closed.
  ALTER TABLE decks ADD COLUMN audio_autoplay INTEGER NOT NULL DEFAULT 0;

  -- Phase 7. A filtered deck is a deck row with a search attached, so every
  -- deck-scoped query, badge and study path already works on it unchanged.
  -- Cards are *borrowed*: original_deck_id is where the card goes home to.
  ALTER TABLE decks ADD COLUMN filtered      INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE decks ADD COLUMN filter_config TEXT;   -- JSON: search, limit, order, reschedule
  ALTER TABLE cards ADD COLUMN original_deck_id TEXT REFERENCES decks(id);
  CREATE INDEX idx_cards_original ON cards(original_deck_id) WHERE original_deck_id IS NOT NULL;

  -- Phase 8. A cloned marketplace deck remembers where it came from, so an
  -- update to the published deck can be offered rather than re-downloaded as a
  -- second copy. NULL on every deck the user made themselves.
  ALTER TABLE decks ADD COLUMN source_listing_id TEXT;
  ALTER TABLE decks ADD COLUMN source_version    INTEGER;
  `,
]

export const SCHEMA_VERSION = MIGRATIONS.length
