import { db } from './client'
import {
  BUILTIN_NOTE_TYPES,
  DECK_OF,
  applyReview,
  clozeText,
  fieldChecksum,
  firstFieldOf,
  generatedOrds,
  mapFields,
  newCard,
  newGuid,
  replayReviews,
  safeDeckName,
  splitDeckPath,
  stripHtml,
  type Card,
  type FieldConfig,
  type Note,
  type NoteType,
  type RatingValue,
  type Review,
} from '@recall/core'

const id = () => crypto.randomUUID()

/**
 * Card ids are derived, not random: `<note id>:<ord>`.
 *
 * That is what lets a card come *back*. Empty the "Add Reverse" field and card 2
 * stops being generated and its row is deleted; fill it in again and the same id
 * reappears, finds its old rows in the append-only review log, and replays them.
 * Anki orphans those cards; here the log means there is nothing to orphan.
 */
export const cardId = (noteId: string, ord: number) => `${noteId}:${ord}`

type CardRow = Omit<Card, 'suspended'> & { suspended: number }
const toCard = (r: CardRow): Card => ({ ...r, suspended: !!r.suspended })

const INSERT_CARD = `INSERT INTO cards (id, note_id, ord, due, stability, difficulty, state,
    learning_steps, reps, lapses, last_review, suspended, buried_until, flag, deck_id)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,0,NULL,0,?)`

const insertParams = (c: Card, deckOverride: string | null = null) => [
  c.id, c.note_id, c.ord, c.due, c.stability, c.difficulty, c.state,
  c.learning_steps, c.reps, c.lapses, c.last_review, deckOverride,
]

const UPDATE_CARD = `UPDATE cards SET due=?, stability=?, difficulty=?, state=?,
  learning_steps=?, reps=?, lapses=?, last_review=? WHERE id=?`

/** The same, plus the deck override — an import can move a card between decks. */
const UPDATE_CARD_DECK = `UPDATE cards SET due=?, stability=?, difficulty=?, state=?,
  learning_steps=?, reps=?, lapses=?, last_review=?, deck_id=? WHERE id=?`

const updateParams = (c: Card) => [
  c.due, c.stability, c.difficulty, c.state,
  c.learning_steps, c.reps, c.lapses, c.last_review, c.id,
]

// ── note types ────────────────────────────────────────────────────────────

type NoteTypeRow = {
  id: string; name: string; fields: string; templates: string
  css: string; kind: NoteType['kind']; ord_field: string | null; builtin: number
  sort_field?: number; field_config?: string; anki_extra?: string
}

/** Tolerant: an import writes these columns, older rows predate them. */
const parseJson = <T>(raw: string | undefined, fallback: T): T => {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

const toNoteType = (r: NoteTypeRow): NoteType => ({
  id: r.id,
  name: r.name,
  fields: JSON.parse(r.fields),
  templates: JSON.parse(r.templates),
  css: r.css,
  kind: r.kind,
  ordField: r.ord_field ?? undefined,
  builtin: !!r.builtin,
  sortField: r.sort_field ?? 0,
  fieldConfig: parseJson(r.field_config, [] as FieldConfig[]),
  ankiExtra: parseJson(r.anki_extra, {} as Record<string, unknown>),
})

/**
 * Built-ins are rewritten on every boot. Safe because native kinds have no
 * template editor by design (PLAN.md §0) — nobody's edits are being clobbered,
 * and a fixed template ships to existing collections without a migration.
 *
 * A template change also changes **which cards existing notes should have**, and
 * `saveNote` only ever regenerates the note in front of you. So anything whose
 * templates or fields actually moved gets a regeneration pass across every note
 * of that type; otherwise shipping a new template would create none of its cards
 * until each note happened to be edited by hand.
 */
export async function ensureNoteTypes() {
  const before = new Map(
    (await db.select<{ id: string; fields: string; templates: string }>(
      'SELECT id, fields, templates FROM note_types WHERE builtin = 1',
    )).map((r) => [r.id, `${r.fields}|${r.templates}`]),
  )

  await db.batch(
    BUILTIN_NOTE_TYPES.map((t) => ({
      // Not INSERT OR REPLACE: that rewrites the whole row, and `field_config`
      // (the sticky flags a person set) and `sort_field` are theirs, not ours.
      sql: `INSERT INTO note_types (id, name, fields, templates, css, kind, ord_field, builtin)
            VALUES (?,?,?,?,?,?,?,1)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name, fields = excluded.fields,
              templates = excluded.templates, css = excluded.css,
              kind = excluded.kind, ord_field = excluded.ord_field, builtin = 1`,
      params: [t.id, t.name, JSON.stringify(t.fields), JSON.stringify(t.templates),
               t.css, t.kind, t.ordField ?? null],
    })),
  )

  for (const t of BUILTIN_NOTE_TYPES) {
    const was = before.get(t.id)
    // Absent means a fresh collection: its notes do not exist yet either.
    if (was === undefined) continue
    if (was !== `${JSON.stringify(t.fields)}|${JSON.stringify(t.templates)}`)
      await regenerateNoteType(t.id)
  }
}

export async function noteTypes(): Promise<NoteType[]> {
  const rows = await db.select<NoteTypeRow>('SELECT * FROM note_types ORDER BY builtin DESC, name')
  return rows.map(toNoteType)
}

export async function getNoteType(id: string): Promise<NoteType | null> {
  const [r] = await db.select<NoteTypeRow>('SELECT * FROM note_types WHERE id = ?', [id])
  return r ? toNoteType(r) : null
}

/** How many notes a type is carrying. Deleting one states this number. */
export async function noteTypeUsage(noteTypeId: string): Promise<number> {
  const [r] = await db.select<{ n: number }>(
    'SELECT COUNT(*) AS n FROM notes WHERE note_type = ?',
    [noteTypeId],
  )
  return r?.n ?? 0
}

/**
 * Mark a row as deliberately deleted, for every device that was not here.
 *
 * A hard delete is invisible to a device that was offline when it happened:
 * that device still holds the row, pushes it on reconnect, and the deletion is
 * quietly undone. The tombstone is what the push loop sends instead, and
 * `synced = 0` on conflict, so a row deleted, restored and deleted again is
 * announced each time rather than only the first.
 *
 * Reviews are absent on purpose — the log is append-only and nothing deletes
 * from it (README, rule 1).
 */
const TOMBSTONE = `INSERT INTO tombstones (resource, key, deleted_at, synced) VALUES (?,?,?,0)
  ON CONFLICT(resource, key) DO UPDATE SET deleted_at = excluded.deleted_at, synced = 0`

/** The same, for rows arriving from a subquery rather than by name. */
const tombstoneCards = (sql: string, params: unknown[]) => ({
  sql: `INSERT INTO tombstones (resource, key, deleted_at, synced) ${sql}
        ON CONFLICT(resource, key) DO UPDATE SET deleted_at = excluded.deleted_at, synced = 0`,
  params,
})

/**
 * Every writable column of a note type, in the order `noteTypeParams` builds.
 *
 * `updated_at` is in the list rather than spelled at each call site so that
 * insert, update and upsert cannot drift: sync finds a changed note type by
 * that column alone, and one write path that forgot to stamp it would be a
 * type that silently never leaves the device.
 */
const NOTE_TYPE_COLUMNS = [
  'name', 'fields', 'templates', 'css', 'kind', 'ord_field',
  'sort_field', 'field_config', 'anki_extra', 'updated_at',
]
const SET_NOTE_TYPE = NOTE_TYPE_COLUMNS.map((c) => `${c} = ?`).join(', ')
const SET_FROM_EXCLUDED = NOTE_TYPE_COLUMNS.map((c) => `${c} = excluded.${c}`).join(', ')

const noteTypeParams = (nt: NoteType, now = Date.now()) => [
  nt.name, JSON.stringify(nt.fields), JSON.stringify(nt.templates), nt.css, nt.kind,
  nt.ordField ?? null, nt.sortField ?? 0,
  JSON.stringify(nt.fieldConfig ?? []), JSON.stringify(nt.ankiExtra ?? {}), now,
]

/**
 * A new custom note type, optionally cloned from an existing one.
 *
 * Cloning is how Anki's "Add: Basic" works and it is the only sane starting
 * point — an empty type generates no cards and cannot be previewed, so there is
 * nothing on screen to edit.
 */
export async function createNoteType(name: string, cloneOf?: string): Promise<string> {
  const base = cloneOf ? await getNoteType(cloneOf) : null
  const ntId = id()
  const nt: NoteType = base
    ? { ...base, id: ntId, name, builtin: false }
    : {
        id: ntId, name, fields: ['Front', 'Back'], kind: 'standard', css: '',
        templates: [{ name: 'Card 1', qfmt: '{{Front}}', afmt: '{{FrontSide}}\n<hr id="answer">\n{{Back}}' }],
      }
  await db.run(
    `INSERT INTO note_types (id, ${NOTE_TYPE_COLUMNS.join(', ')}, builtin)
     VALUES (?, ${NOTE_TYPE_COLUMNS.map(() => '?').join(', ')}, 0)`,
    [ntId, ...noteTypeParams(nt)],
  )
  return ntId
}

/**
 * Write a note type back, bringing every note and card of that type in line.
 *
 * Three things have to move together, which is why this is one call and not
 * three: the type's own row, the **field names inside every note's JSON**, and
 * the cards the new templates do or do not generate. Skipping the middle step
 * renames a field and detaches its content; skipping the last one adds a
 * template that produces no cards until each note is edited by hand
 * (CARDS.md §5).
 *
 * `renames` maps old field name to new, and only the caller knows it — by the
 * time both versions of the type are in hand, a rename and a delete-plus-add
 * are indistinguishable, and they mean opposite things for the note content.
 */
export async function saveNoteType(
  next: NoteType,
  renames: Record<string, string> = {},
  now = Date.now(),
): Promise<number> {
  const before = await getNoteType(next.id)
  if (!before) throw new Error(`Unknown note type: ${next.id}`)
  if (!next.fields.length) throw new Error('A note type needs at least one field')
  if (new Set(next.fields).size !== next.fields.length)
    throw new Error('Two fields cannot share a name')
  if (!next.templates.length) throw new Error('A note type needs at least one template')

  await db.run(`UPDATE note_types SET ${SET_NOTE_TYPE} WHERE id = ?`,
    [...noteTypeParams(next, now), next.id])

  const shape = (t: NoteType) => `${JSON.stringify(t.fields)}|${JSON.stringify(t.templates)}`
  if (shape(before) === shape(next)) return 0

  await remapNotes(next, (fields) => {
    const moved: Record<string, string> = {}
    for (const [from, to] of Object.entries(renames))
      if (from in fields) moved[to] = fields[from]!
    // Field order decides the first field, which decides the checksum, so the
    // rebuild is by the new type's names rather than a patch of the old object.
    return Object.fromEntries(next.fields.map((f) => [f, moved[f] ?? fields[f] ?? '']))
  }, now)

  return regenerateNoteType(next.id, now)
}

/** Rewrite every note of a type through `fn`, keeping the checksum honest. */
async function remapNotes(
  nt: NoteType,
  fn: (fields: Record<string, string>) => Record<string, string>,
  now: number,
) {
  const rows = await db.select<{ id: string; fields: string }>(
    'SELECT id, fields FROM notes WHERE note_type = ?',
    [nt.id],
  )
  if (!rows.length) return
  await db.batch(rows.map((r) => {
    const fields = fn(JSON.parse(r.fields))
    return {
      sql: 'UPDATE notes SET note_type = ?, fields = ?, checksum = ?, updated_at = ? WHERE id = ?',
      params: [nt.id, JSON.stringify(fields), fieldChecksum(firstFieldOf(nt.fields, fields)), now, r.id],
    }
  }))
}

/**
 * Write imported note types, keeping our own untouched.
 *
 * Imported types land in the same table as the built-ins, which is the whole
 * point of PLAN.md §0: one renderer, one code path, and no "compatibility mode"
 * that only some cards go through. They are never marked builtin, so
 * `ensureNoteTypes` leaves them alone forever.
 */
export const upsertNoteTypes = (types: NoteType[]) =>
  db.batch(types.map((nt) => ({
    sql: `INSERT INTO note_types (id, ${NOTE_TYPE_COLUMNS.join(', ')}, builtin)
          VALUES (?, ${NOTE_TYPE_COLUMNS.map(() => '?').join(', ')}, 0)
          ON CONFLICT(id) DO UPDATE SET ${SET_FROM_EXCLUDED}`,
    params: [nt.id, ...noteTypeParams(nt)],
  })))

/**
 * Sticky lives on the note type, not in component state: "keep the deck name I
 * just typed" is a property of the type you are adding to, and it has to be
 * there tomorrow. Written on its own rather than through `saveNoteType`, which
 * would regenerate every card of the type to toggle a pin.
 */
export async function setFieldSticky(noteTypeId: string, field: string, sticky: boolean) {
  const nt = await getNoteType(noteTypeId)
  const at = nt?.fields.indexOf(field) ?? -1
  if (!nt || at < 0) return
  const cfg = nt.fields.map((_, i) => nt.fieldConfig?.[i] ?? {})
  cfg[at] = { ...cfg[at], sticky }
  await db.run('UPDATE note_types SET field_config = ? WHERE id = ?', [JSON.stringify(cfg), noteTypeId])
}

/**
 * Delete a note type. Refuses while notes still use it — Anki deletes those
 * notes with it, which is a lot of work to lose behind one confirmation.
 * Change the notes across first; that is what `changeNoteType` is for.
 */
export async function deleteNoteType(noteTypeId: string): Promise<void> {
  const nt = await getNoteType(noteTypeId)
  if (!nt) return
  if (nt.builtin) throw new Error('Built-in note types cannot be deleted')
  const used = await noteTypeUsage(noteTypeId)
  if (used) throw new Error(`${used} note${used === 1 ? '' : 's'} still use this type`)
  await db.batch([
    { sql: TOMBSTONE, params: ['note_types', noteTypeId, Date.now()] },
    { sql: 'DELETE FROM note_types WHERE id = ?', params: [noteTypeId] },
  ])
}

/**
 * Move notes to another note type — Anki's own flow, and the repair path when
 * an import maps a deck badly.
 *
 * `fieldMap` is keyed by **target** field name, `templateMap` by source ordinal.
 * Cards whose ordinal is mapped keep their scheduling state; the rest are
 * dropped and regenerated from the target's templates.
 *
 * ponytail: a remapped card carries its state to the new ordinal but its rows
 * in the append-only review log stay under the old card id. Delete and
 * regenerate that card afterwards and it replays the ordinal's older history.
 * Rewrite the log here once sync can reconcile an id change (Phase 5).
 */
export async function changeNoteType(
  noteIds: string[],
  toTypeId: string,
  fieldMap: Record<string, string | null>,
  templateMap: Record<number, number | null> = {},
  now = Date.now(),
): Promise<number> {
  const to = await getNoteType(toTypeId)
  if (!to) throw new Error(`Unknown note type: ${toTypeId}`)
  if (!noteIds.length) return 0

  const holes = noteIds.map(() => '?').join(',')
  const notes = await db.select<{ id: string; deck_id: string; fields: string }>(
    `SELECT id, deck_id, fields FROM notes WHERE id IN (${holes})`,
    noteIds,
  )
  const cards = await db.select<CardRow & { deck_id: string | null }>(
    `SELECT * FROM cards WHERE note_id IN (${holes})`,
    noteIds,
  )

  for (const n of notes) {
    const fields = mapFields(to, JSON.parse(n.fields), fieldMap)
    const kept = cards
      .filter((c) => c.note_id === n.id)
      .map((c) => ({ card: c, ord: templateMap[c.ord] ?? null }))
      .filter((c): c is { card: typeof cards[number]; ord: number } => c.ord !== null)

    await db.batch([
      {
        sql: `UPDATE notes SET note_type = ?, fields = ?, checksum = ?, updated_at = ? WHERE id = ?`,
        params: [to.id, JSON.stringify(fields),
                 fieldChecksum(firstFieldOf(to.fields, fields)), now, n.id],
      },
      // Every card first, then the survivors back: the ids are derived from the
      // ordinal, so a swap would otherwise collide with a row still standing.
      { sql: 'DELETE FROM cards WHERE note_id = ?', params: [n.id] },
      ...kept.map(({ card, ord }) => ({
        sql: INSERT_CARD,
        params: insertParams(
          { ...toCard(card), id: cardId(n.id, ord), ord },
          overrideOf(to, ord),
        ),
      })),
    ])

    await regenerateCards(n.id, to, fields, n.deck_id, now)
  }
  return notes.length
}

// ── decks ─────────────────────────────────────────────────────────────────

export interface DeckRow {
  id: string
  parent_id: string | null
  name: string
  path: string
  depth: number
  due: number
  new: number
  retention_target: number
  new_per_day: number
  /** 1 for a filtered deck, whose cards are borrowed and go home when it empties. */
  filtered: number
}

// ── deck management ──────────────────────────────────────────────

/**
 * Create a deck, optionally under a parent.
 *
 * `::` is stripped from the name rather than accepted: Anki treats it as a path
 * separator, so a deck literally called "Heart::Valves" would export as two
 * decks and never come back the same shape (CARDS.md §5.5).
 */
export async function createDeck(name: string, parentId: string | null = null): Promise<string> {
  const clean = safeDeckName(name)
  if (!clean) throw new Error('A deck needs a name')
  const deckId = id()
  try {
    // The defaults come from settings rather than being literals here, read in
    // the same statement so a new deck cannot race a preference change. Both
    // are clamped on write by setSchedulingDefaults; COALESCE covers the
    // collection that has never opened settings at all.
    await db.run(
      `INSERT INTO decks (id, parent_id, name, updated_at, retention_target, new_per_day) VALUES (?,?,?,?,
         COALESCE((SELECT CAST(value AS REAL)    FROM sync_state WHERE key = 'pref.scheduling.retention'),   0.9),
         COALESCE((SELECT CAST(value AS INTEGER) FROM sync_state WHERE key = 'pref.scheduling.new_per_day'), 20))`,
      [deckId, parentId, clean, Date.now()],
    )
  } catch (e) {
    throw siblingClash(e, clean)
  }
  return deckId
}

/**
 * Sibling names are unique (migration 4), so the database is what enforces it.
 * Checking first would race; this turns the constraint into something a person
 * can read.
 */
function siblingClash(e: unknown, name: string): Error {
  const msg = e instanceof Error ? e.message : String(e)
  return /UNIQUE|constraint/i.test(msg)
    ? new Error(`There is already a deck called “${name}” here`)
    : e instanceof Error ? e : new Error(msg)
}

/**
 * Resolve an Anki deck path to a deck id, creating the whole chain as needed.
 *
 * Anki has no deck tree — only flat names with `::` — so this is the mapping
 * Phase 4's importer runs for every deck it meets, and it is also what "type a
 * new deck name in the picker" uses. Idempotent: the same path always lands on
 * the same deck.
 */
export async function deckByPath(path: string): Promise<string> {
  const parts = splitDeckPath(path)
  if (!parts.length) throw new Error('A deck needs a name')
  let parent: string | null = null
  for (const part of parts) parent = await childDeck(part, parent)
  return parent!
}

async function childDeck(name: string, parentId: string | null): Promise<string> {
  const rows = await db.select<{ id: string }>(
    'SELECT id FROM decks WHERE name = ? AND parent_id IS ?',
    [name, parentId],
  )
  return rows[0]?.id ?? createDeck(name, parentId)
}

export async function renameDeck(deckId: string, name: string): Promise<void> {
  const clean = safeDeckName(name)
  if (!clean) throw new Error('A deck needs a name')
  try {
    await db.run('UPDATE decks SET name = ?, updated_at = ? WHERE id = ?', [clean, Date.now(), deckId])
  } catch (e) {
    throw siblingClash(e, clean)
  }
}

/**
 * Re-parent a deck. Refuses to move a deck inside its own subtree, which would
 * detach the whole branch from every root and make it unreachable.
 */
export async function moveDeck(deckId: string, parentId: string | null): Promise<void> {
  if (deckId === parentId) throw new Error('A deck cannot be its own parent')
  if (parentId) {
    const inside = await db.select<{ id: string }>(
      `WITH RECURSIVE sub(id) AS (
         SELECT ? UNION ALL SELECT d.id FROM decks d JOIN sub ON d.parent_id = sub.id
       ) SELECT id FROM sub WHERE id = ?`,
      [deckId, parentId],
    )
    if (inside.length) throw new Error('A deck cannot move inside itself')
  }
  const [self] = await db.select<{ name: string }>('SELECT name FROM decks WHERE id = ?', [deckId])
  try {
    await db.run('UPDATE decks SET parent_id = ?, updated_at = ? WHERE id = ?', [parentId, Date.now(), deckId])
  } catch (e) {
    throw siblingClash(e, self?.name ?? 'that')
  }
}

/** What a delete would take with it. The confirmation states these numbers. */
export async function deckContents(deckId: string) {
  const [r] = await db.select<{ decks: number; notes: number; cards: number }>(
    `WITH RECURSIVE sub(id) AS (
       SELECT ? UNION ALL SELECT d.id FROM decks d JOIN sub ON d.parent_id = sub.id
     )
     SELECT (SELECT COUNT(*) FROM sub) AS decks,
            (SELECT COUNT(*) FROM notes WHERE deck_id IN (SELECT id FROM sub)) AS notes,
            (SELECT COUNT(*) FROM cards c JOIN notes n ON n.id = c.note_id
              WHERE ${DECK_OF} IN (SELECT id FROM sub)) AS cards`,
    [deckId],
  )
  return { decks: r?.decks ?? 0, notes: r?.notes ?? 0, cards: r?.cards ?? 0 }
}

/**
 * Delete a deck and everything under it.
 *
 * Notes and cards cascade. **Reviews do not** — the log is append-only, so the
 * rows stay and a note re-imported with the same guid finds its history again.
 *
 * A card belonging to a note *elsewhere* can still point into this subtree via
 * a template deck override. Those are released to NULL first, which sends them
 * back to their note's deck rather than leaving a reference to a deck that is
 * about to stop existing.
 */
export const deleteDeck = (deckId: string, now = Date.now()) =>
  db.batch([
    // The subtree's decks, its notes and their card states, all read before
    // anything is removed — the cascade makes them unreachable afterwards.
    {
      // Borrowed cards go home first. Their notes live in other decks, so
      // nothing cascades them — they would simply be left flagged as borrowed
      // forever, never eligible for another filtered deck, with any template
      // override lost. Here rather than in the filtered-deck code because every
      // delete path routes through this one.
      sql: `UPDATE cards
               SET deck_id = CASE
                     WHEN original_deck_id = (SELECT deck_id FROM notes WHERE notes.id = cards.note_id)
                     THEN NULL ELSE original_deck_id END,
                   original_deck_id = NULL,
                   state_updated_at = ?
             WHERE original_deck_id IS NOT NULL
               AND deck_id IN (
                 WITH RECURSIVE sub(id) AS (
                   SELECT ? UNION ALL SELECT d.id FROM decks d JOIN sub ON d.parent_id = sub.id
                 ) SELECT id FROM sub)`,
      params: [now, deckId],
    },
    tombstoneCards(
      `WITH RECURSIVE sub(id) AS (
         SELECT ? UNION ALL SELECT d.id FROM decks d JOIN sub ON d.parent_id = sub.id
       )
       SELECT 'decks', id, ?, 0 FROM sub
       UNION ALL SELECT 'notes', n.id, ?, 0 FROM notes n JOIN sub ON n.deck_id = sub.id
       UNION ALL SELECT 'card_states', c.id, ?, 0 FROM cards c
              JOIN notes n ON n.id = c.note_id JOIN sub ON n.deck_id = sub.id`,
      [deckId, now, now, now],
    ),
    {
      sql: `UPDATE cards SET deck_id = NULL WHERE deck_id IN (
              WITH RECURSIVE sub(id) AS (
                SELECT ? UNION ALL SELECT d.id FROM decks d JOIN sub ON d.parent_id = sub.id
              ) SELECT id FROM sub)`,
      params: [deckId],
    },
    { sql: 'DELETE FROM decks WHERE id = ?', params: [deckId] },
  ])

/**
 * Deck options. Retention applies to the *next* review of each card — nothing
 * reschedules retroactively, because the log records what was actually shown
 * and when, and rewriting that would be a lie.
 */
export const setDeckOptions = (deckId: string, retention: number, newPerDay: number) =>
  db.run('UPDATE decks SET retention_target = ?, new_per_day = ?, updated_at = ? WHERE id = ?', [
    retention,
    Math.min(9999, Math.max(0, Math.round(newPerDay) || 0)),
    Date.now(),
    deckId,
  ])

/**
 * A card's deck, which is the note's deck unless a template overrides it.
 *
 * A card template can carry a **deck override** — the classic case is a
 * reversed template sending its cards to a separate "Recognition" deck. It is
 * NULL for every card until an import says otherwise, and it has to be spelled
 * the same way in every deck-scoped query or the badges and the study loop stop
 * agreeing (README, rule 4).
 *
 * Defined in core rather than here because the search compiler and the filtered
 * deck builder spell it too, and three copies of one expression is three places
 * for the badges and the study loop to start disagreeing.
 */

/**
 * Cards introduced today, per deck.
 *
 * Anki's daily new limit counts cards *studied* for the first time, not cards
 * created, so the source is the review log: a card's first-ever review. That
 * also means the limit survives a rebuild of the `cards` cache.
 */
const INTRODUCED_TODAY = `
  SELECT ${DECK_OF} AS id, COUNT(*) AS n
    FROM (SELECT card_id, MIN(ts) AS first_ts FROM reviews GROUP BY card_id) f
    JOIN cards c ON c.id = f.card_id
    JOIN notes n ON n.id = c.note_id
   WHERE f.first_ts >= ?1
   GROUP BY ${DECK_OF}`

/**
 * The whole tree, in tree order, with counts **rolled up into every ancestor** —
 * one query. A parent shows what studying it would actually cost, which means
 * `sub` walks each deck's whole subtree and sums the leaves into it.
 *
 * Every filter here has to match `nextCard` exactly. A badge that promises a
 * card the study loop then refuses to hand over is worse than no badge: buried
 * cards are excluded, and the new count is capped by what is left of the deck's
 * daily allowance.
 *
 * This recursive CTE is the thing IndexedDB could not have done, and it is why
 * the local store is SQLite (PLAN.md §2.5).
 *
 * ponytail: the new limit is charged to the card's own deck, not to the parent
 * being studied. Anki charges the parent too; add that when someone sets a
 * limit on a parent and expects it to bind its children.
 */
export async function deckTree(now = Date.now()): Promise<DeckRow[]> {
  return db.select<DeckRow>(
    `WITH RECURSIVE
       tree(id, parent_id, name, path, depth) AS (
         SELECT id, parent_id, name, name, 0 FROM decks WHERE parent_id IS NULL
         UNION ALL
         SELECT d.id, d.parent_id, d.name, t.path || ' · ' || d.name, t.depth + 1
           FROM decks d JOIN tree t ON d.parent_id = t.id
       ),
       sub(root, id) AS (
         SELECT id, id FROM decks
         UNION ALL
         SELECT s.root, d.id FROM decks d JOIN sub s ON d.parent_id = s.id
       ),
       intro AS (${INTRODUCED_TODAY}),
       own AS (
         SELECT ${DECK_OF} AS id,
                COUNT(CASE WHEN c.state != 'new' AND c.due <= ?2 THEN 1 END) AS due,
                COUNT(CASE WHEN c.state  = 'new' THEN 1 END) AS avail
           FROM notes n JOIN cards c ON c.note_id = n.id
          WHERE c.suspended = 0 AND (c.buried_until IS NULL OR c.buried_until <= ?2)
          GROUP BY ${DECK_OF}
       ),
       capped AS (
         SELECT d.id,
                COALESCE(o.due, 0) AS due,
                MIN(COALESCE(o.avail, 0), MAX(d.new_per_day - COALESCE(i.n, 0), 0)) AS new
           FROM decks d
           LEFT JOIN own o   ON o.id = d.id
           LEFT JOIN intro i ON i.id = d.id
       )
     SELECT t.id, t.parent_id, t.name, t.path, t.depth,
            dk.retention_target, dk.new_per_day, dk.filtered,
            COALESCE(SUM(c.due), 0) AS due,
            COALESCE(SUM(c.new), 0) AS new
       FROM tree t
       JOIN decks dk ON dk.id = t.id
       JOIN sub s ON s.root = t.id
       LEFT JOIN capped c ON c.id = s.id
      GROUP BY t.id
      ORDER BY t.path`,
    [startOfToday(), now],
  )
}

// ── notes ─────────────────────────────────────────────────────────────────

export interface NoteRow extends Note {
  cards: number
  preview: string
}

/** Notes in a deck and everything under it — the browser follows the tree. */
export async function notesInDeck(deckId: string): Promise<NoteRow[]> {
  const rows = await db.select<any>(
    `WITH RECURSIVE sub(id) AS (
       SELECT ? UNION ALL SELECT d.id FROM decks d JOIN sub ON d.parent_id = sub.id
     )
     SELECT n.*, (SELECT COUNT(*) FROM cards c WHERE c.note_id = n.id) AS cards,
            t.fields AS nt_fields, t.sort_field AS nt_sort
       FROM notes n
       JOIN note_types t ON t.id = n.note_type
      WHERE n.deck_id IN (SELECT id FROM sub)
         OR EXISTS (SELECT 1 FROM cards c
                     WHERE c.note_id = n.id AND c.deck_id IN (SELECT id FROM sub))
      ORDER BY n.updated_at DESC
      LIMIT 500`,
    [deckId],
  )
  return rows.map((r) => {
    const fields: Record<string, string> = JSON.parse(r.fields)
    return {
      id: r.id,
      note_type: r.note_type,
      deck_id: r.deck_id,
      fields,
      tags: r.tags ? String(r.tags).split(' ').filter(Boolean) : [],
      fma_id: r.fma_id,
      updated_at: r.updated_at,
      cards: r.cards,
      // Deletions are unwrapped: a list is for finding the note, and
      // `{{c1::…}}` in every row is noise.
      preview: clozeText(stripHtml(sortValue(r, fields))).trim(),
    }
  })
}

/**
 * What a row in the browser shows.
 *
 * The note type's **sort field** decides, because "first non-empty" is a guess
 * that is wrong for every type whose first field is an id or a media reference
 * (CARDS.md §7) — an occlusion note would list its shape JSON. First non-empty
 * stays as the fallback, so a sort field left blank still shows something.
 */
function sortValue(row: { nt_fields: string; nt_sort: number }, fields: Record<string, string>): string {
  const names: string[] = JSON.parse(row.nt_fields)
  const chosen = fields[names[row.nt_sort ?? 0] ?? ''] ?? ''
  return stripHtml(chosen).trim()
    ? chosen
    : (Object.values(fields).find((v) => stripHtml(v).trim()) ?? '')
}

export async function getNote(noteId: string): Promise<Note | null> {
  const [r] = await db.select<any>('SELECT * FROM notes WHERE id = ?', [noteId])
  if (!r) return null
  return {
    id: r.id, note_type: r.note_type, deck_id: r.deck_id,
    fields: JSON.parse(r.fields),
    tags: r.tags ? String(r.tags).split(' ').filter(Boolean) : [],
    fma_id: r.fma_id, updated_at: r.updated_at,
  }
}

export interface SaveNote {
  id?: string
  /** Only ever set by the importer, which carries the source note's identity. */
  guid?: string
  noteTypeId: string
  deckId: string
  fields: Record<string, string>
  tags?: string[]
  fmaId?: string | null
}

/** Create or update a note, then bring its cards in line with the templates. */
export async function saveNote(input: SaveNote, now = Date.now()): Promise<string> {
  const types = await noteTypes()
  const nt = types.find((t) => t.id === input.noteTypeId)
  if (!nt) throw new Error(`Unknown note type: ${input.noteTypeId}`)

  const noteId = input.id ?? id()
  await db.run(
    `INSERT INTO notes (id, guid, note_type, deck_id, fields, tags, fma_id, checksum, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       note_type = excluded.note_type, deck_id = excluded.deck_id,
       fields = excluded.fields, tags = excluded.tags,
       fma_id = excluded.fma_id, checksum = excluded.checksum,
       updated_at = excluded.updated_at`,
    // `guid` is deliberately absent from the DO UPDATE list: it is minted once
    // and never rewritten, because it is what an importer matches this note by
    // for the rest of its life (CARDS.md §4.5).
    [noteId, input.guid ?? newGuid(), nt.id, input.deckId, JSON.stringify(input.fields),
     (input.tags ?? []).join(' '), input.fmaId ?? null,
     fieldChecksum(firstFieldOf(nt.fields, input.fields)), now],
  )

  await regenerateCards(noteId, nt, input.fields, input.deckId, now)
  return noteId
}

/**
 * Other notes of this type whose first field matches — the add screen's
 * duplicate warning. Non-blocking: duplicates are legal, just usually a mistake.
 */
export async function duplicatesOf(
  nt: NoteType,
  fields: Record<string, string>,
  exceptNoteId?: string,
): Promise<number> {
  const first = firstFieldOf(nt.fields, fields)
  if (!stripHtml(first).trim()) return 0
  const [r] = await db.select<{ n: number }>(
    `SELECT COUNT(*) AS n FROM notes
      WHERE note_type = ? AND checksum = ? AND id != ?`,
    [nt.id, fieldChecksum(first), exceptNoteId ?? ''],
  )
  return r?.n ?? 0
}

/** Every tag in the collection, for autocomplete. */
export async function allTags(): Promise<string[]> {
  const rows = await db.select<{ tags: string }>(
    `SELECT DISTINCT tags FROM notes WHERE tags != ''`,
  )
  const seen = new Set<string>()
  for (const r of rows) for (const t of r.tags.split(' ')) if (t) seen.add(t)
  return [...seen].sort()
}

/**
 * Re-run generation for **every** note of a note type.
 *
 * `saveNote` only ever regenerates the note in front of you, which is right
 * until the *type* changes. Add a template to a 4,000-note type and without
 * this none of the 4,000 cards appear; remove one and 4,000 cards keep
 * rendering from a template that is gone. Returns how many notes moved, which
 * is what the confirmation dialog shows.
 */
export async function regenerateNoteType(noteTypeId: string, now = Date.now()): Promise<number> {
  const nt = (await noteTypes()).find((t) => t.id === noteTypeId)
  if (!nt) throw new Error(`Unknown note type: ${noteTypeId}`)
  const notes = await db.select<{ id: string; deck_id: string; fields: string }>(
    'SELECT id, deck_id, fields FROM notes WHERE note_type = ?',
    [noteTypeId],
  )
  let changed = 0
  for (const n of notes)
    if (await regenerateCards(n.id, nt, JSON.parse(n.fields), n.deck_id, now)) changed++
  return changed
}

/** A template's deck override, or null to follow the note. */
const overrideOf = (nt: NoteType, ord: number): string | null =>
  (nt.kind === 'standard' ? nt.templates[ord]?.deckOverride : null) ?? null

async function regenerateCards(
  noteId: string,
  nt: NoteType,
  fields: Record<string, string>,
  deckId: string,
  now: number,
): Promise<boolean> {
  const want = generatedOrds(nt, fields)
  const have = await db.select<{ id: string; ord: number }>(
    'SELECT id, ord FROM cards WHERE note_id = ?',
    [noteId],
  )
  const missing = want.filter((ord) => !have.some((h) => h.ord === ord))
  const extra = have.filter((h) => !want.includes(h.ord))
  if (!missing.length && !extra.length) return false

  // Retention belongs to the deck the card actually lands in, which a template
  // override can change.
  const decks = [...new Set([deckId, ...missing.map((o) => overrideOf(nt, o))].filter(Boolean))]
  const rates = new Map(
    (await db.select<{ id: string; retention_target: number }>(
      `SELECT id, retention_target FROM decks WHERE id IN (${decks.map(() => '?').join(',')})`,
      decks as string[],
    )).map((d) => [d.id, d.retention_target]),
  )

  // One query for the whole note's history instead of one per new ordinal —
  // the fan-out across a 4,000-note type runs this for every note.
  const log = missing.length
    ? await db.select<Review>(
        `SELECT * FROM reviews WHERE card_id IN (${missing.map(() => '?').join(',')}) ORDER BY ts`,
        missing.map((ord) => cardId(noteId, ord)),
      )
    : []

  const stmts: { sql: string; params?: unknown[] }[] = []
  for (const ord of missing) {
    const cid = cardId(noteId, ord)
    const override = overrideOf(nt, ord)
    const retention = rates.get(override ?? deckId) ?? 0.9
    // The card may have existed before. If it did, its history is still in the
    // log, and replaying it is more honest than starting the user over.
    const own = log.filter((r) => r.card_id === cid)
    const card = own.length
      ? replayReviews({ id: cid, note_id: noteId, ord }, own, retention, own[0]!.ts)
      : newCard(cid, noteId, ord, now)
    stmts.push({ sql: INSERT_CARD, params: insertParams(card, override) })
  }

  for (const h of extra)
    stmts.push({ sql: 'DELETE FROM cards WHERE id = ?', params: [h.id] })

  await db.batch(stmts)
  return true
}

export const deleteNote = (noteId: string, now = Date.now()) =>
  db.batch([
    // Tombstones before the DELETEs: they read the rows that are about to go.
    tombstoneCards(
      `SELECT 'card_states', id, ?, 0 FROM cards WHERE note_id = ?`,
      [now, noteId],
    ),
    { sql: TOMBSTONE, params: ['notes', noteId, now] },
    { sql: 'DELETE FROM cards WHERE note_id = ?', params: [noteId] },
    { sql: 'DELETE FROM notes WHERE id = ?', params: [noteId] },
  ])

// ── study ─────────────────────────────────────────────────────────────────

export interface StudyCard {
  card: Card
  note: Note
  noteType: NoteType
  deckPath: string
  deckName: string
  retentionTarget: number
}

/**
 * Decks that have already handed out their new cards for the day.
 *
 * Pulled out as its own query rather than a correlated subquery in `nextCard`:
 * it is one small scan, and `nextCard` runs on every single answer.
 */
async function decksAtNewLimit(): Promise<string[]> {
  const rows = await db.select<{ id: string }>(
    `SELECT i.id FROM (${INTRODUCED_TODAY}) i
       JOIN decks d ON d.id = i.id
      WHERE i.n >= d.new_per_day`,
    [startOfToday()],
  )
  return rows.map((r) => r.id)
}

/** Due cards first, then new. Optionally scoped to a deck and its subdecks. */
export async function nextCard(deckId?: string | null, now = Date.now()): Promise<StudyCard | null> {
  const scope = deckId
    ? `AND ${DECK_OF} IN (
         WITH RECURSIVE sub(id) AS (
           SELECT ? UNION ALL SELECT d.id FROM decks d JOIN sub ON d.parent_id = sub.id
         ) SELECT id FROM sub)`
    : ''
  // A deck out of new-card allowance still serves its reviews; it just stops
  // introducing. The badge in the deck list is capped the same way (deckTree).
  const spent = await decksAtNewLimit()
  const limit = spent.length
    ? `AND (c.state != 'new' OR ${DECK_OF} NOT IN (${spent.map(() => '?').join(',')}))`
    : ''
  const rows = await db.select<any>(
    `SELECT c.*, n.fields, n.tags, n.note_type, n.fma_id, n.deck_id, n.updated_at,
            d.retention_target, d.name AS deck_name,
            p.name AS parent_name, g.name AS grandparent_name,
            t.id AS nt_id, t.name AS nt_name, t.fields AS nt_fields,
            t.templates AS nt_templates, t.css AS nt_css, t.kind AS nt_kind,
            t.ord_field AS nt_ord_field, t.builtin AS nt_builtin,
            t.sort_field AS nt_sort_field, t.field_config AS nt_field_config,
            t.anki_extra AS nt_anki_extra
       FROM cards c
       JOIN notes n ON n.id = c.note_id
       JOIN decks d ON d.id = ${DECK_OF}
       JOIN note_types t ON t.id = n.note_type
       LEFT JOIN decks p ON p.id = d.parent_id
       LEFT JOIN decks g ON g.id = p.parent_id
      WHERE c.suspended = 0
        AND (c.buried_until IS NULL OR c.buried_until <= ?)
        AND (c.state != 'new' AND c.due <= ? OR c.state = 'new')
        ${scope}
        ${limit}
      ORDER BY (c.state = 'new') ASC, c.due ASC
      LIMIT 1`,
    [now, now, ...(deckId ? [deckId] : []), ...spent],
  )
  const r = rows[0]
  if (!r) return null
  return {
    card: toCard(r as CardRow),
    note: {
      id: r.note_id,
      note_type: r.note_type,
      deck_id: r.deck_id,
      fields: JSON.parse(r.fields),
      tags: r.tags ? String(r.tags).split(' ').filter(Boolean) : [],
      fma_id: r.fma_id,
      updated_at: r.updated_at,
    },
    noteType: toNoteType({
      id: r.nt_id, name: r.nt_name, fields: r.nt_fields, templates: r.nt_templates,
      css: r.nt_css, kind: r.nt_kind, ord_field: r.nt_ord_field, builtin: r.nt_builtin,
      sort_field: r.nt_sort_field, field_config: r.nt_field_config, anki_extra: r.nt_anki_extra,
    }),
    deckPath: [r.grandparent_name, r.parent_name, r.deck_name].filter(Boolean).join(' · '),
    deckName: r.deck_name,
    retentionTarget: r.retention_target,
  }
}

/**
 * What is left, and what has been done, for the session in front of the user.
 *
 * Scoped to the deck being studied — a progress bar that counts the whole
 * collection while you study one subdeck is just a wrong number. Waiting counts
 * come straight from `deckTree` rather than a second set of WHERE clauses, so
 * they cannot drift away from the badges or from `nextCard`.
 */
export async function counts(deckId?: string | null, now = Date.now()) {
  const tree = await deckTree(now)
  const rows = deckId ? tree.filter((d) => d.id === deckId) : tree.filter((d) => !d.parent_id)

  const [r] = await db.select<{ done: number }>(
    `SELECT COUNT(*) AS done FROM reviews r
      WHERE r.ts >= ?
        ${deckId
          ? `AND r.card_id IN (
               SELECT c.id FROM cards c JOIN notes n ON n.id = c.note_id
                WHERE ${DECK_OF} IN (
                  WITH RECURSIVE sub(id) AS (
                    SELECT ? UNION ALL SELECT d.id FROM decks d JOIN sub ON d.parent_id = sub.id
                  ) SELECT id FROM sub))`
          : ''}`,
    deckId ? [startOfToday(), deckId] : [startOfToday()],
  )

  return {
    due: rows.reduce((t, d) => t + d.due, 0),
    new: rows.reduce((t, d) => t + d.new, 0),
    done: r?.done ?? 0,
  }
}

const startOfToday = () => new Date(new Date().setHours(0, 0, 0, 0)).getTime()

export async function recordReview(
  sc: StudyCard,
  rating: RatingValue,
  durationMs: number,
  now = Date.now(),
) {
  const next = applyReview(sc.card, rating, now, sc.retentionTarget)
  await db.batch([
    {
      sql: `INSERT INTO reviews (id, card_id, ts, rating, duration_ms, synced)
            VALUES (?, ?, ?, ?, ?, 0)`,
      params: [id(), sc.card.id, now, rating, durationMs],
    },
    { sql: UPDATE_CARD, params: updateParams(next) },
  ])
  return next
}

/**
 * Undo removes the last review *and rebuilds the card from the remaining log*.
 *
 * The append-only rule holds where it matters: a review becomes immutable once
 * synced. Before that it never left this device, so dropping a mis-click is
 * safe and keeps the log honest — better than logging a rating the user did not
 * mean. Phase 4 must therefore only ever delete rows with synced = 0.
 */
export async function undoLast(): Promise<boolean> {
  const [last] = await db.select<Review & { synced: number }>(
    // `imported = 0`: the newest row in the log after an import is a review
    // from years ago that has just arrived, and undo must not eat it.
    `SELECT * FROM reviews WHERE synced = 0 AND imported = 0 ORDER BY ts DESC LIMIT 1`,
  )
  if (!last) return false

  const [meta] = await db.select<{ note_id: string; ord: number; retention_target: number }>(
    `SELECT c.note_id, c.ord, d.retention_target
       FROM cards c JOIN notes n ON n.id = c.note_id
       JOIN decks d ON d.id = ${DECK_OF}
      WHERE c.id = ?`,
    [last.card_id],
  )
  if (!meta) return false

  await db.run(`DELETE FROM reviews WHERE id = ?`, [last.id])
  const remaining = await db.select<Review>(
    `SELECT * FROM reviews WHERE card_id = ? ORDER BY ts`,
    [last.card_id],
  )
  const rebuilt = replayReviews(
    { id: last.card_id, note_id: meta.note_id, ord: meta.ord },
    remaining,
    meta.retention_target,
    remaining[0]?.ts ?? Date.now(),
  )
  await db.run(UPDATE_CARD, updateParams(rebuilt))
  return true
}

/**
 * The three writes that are a *decision* rather than a derived value.
 *
 * `suspended`, `buried_until`, `flag` and `deck_id` are the `card_states`
 * subset that syncs — everything else in `cards` is FSRS output that
 * `replayReviews()` rebuilds. Each one stamps `state_updated_at`, which is what
 * the push loop reads to find them: without the stamp a suspend made here is
 * invisible to sync and simply never leaves the device.
 */
export const setFlag = (cardId: string, flag: number, now = Date.now()) =>
  db.run(`UPDATE cards SET flag = ?, state_updated_at = ? WHERE id = ?`, [flag, now, cardId])

export const suspend = (cardId: string, now = Date.now()) =>
  db.run(`UPDATE cards SET suspended = 1, state_updated_at = ? WHERE id = ?`, [now, cardId])

export const bury = (cardId: string, now = Date.now()) =>
  db.run(`UPDATE cards SET buried_until = ?, state_updated_at = ? WHERE id = ?`, [
    tomorrow(),
    now,
    cardId,
  ])

const tomorrow = () => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime() + 86_400_000
}

export async function seedIfEmpty() {
  await ensureNoteTypes()
  const rows = await db.select<{ n: number }>('SELECT COUNT(*) AS n FROM decks')
  if ((rows[0]?.n ?? 0) > 0) return
  const { SEED } = await import('./seed')
  const now = Date.now()
  const stmts: { sql: string; params?: unknown[] }[] = []

  for (const d of SEED.decks)
    stmts.push({
      sql: `INSERT INTO decks (id, parent_id, name, retention_target, new_per_day) VALUES (?,?,?,?,?)`,
      params: [d.id, d.parent_id, d.name, d.retention_target ?? 0.9, d.new_per_day ?? 20],
    })

  for (const note of SEED.notes) {
    const noteId = id()
    const nt = BUILTIN_NOTE_TYPES.find((t) => t.id === note.type)!
    stmts.push({
      // The guid is not optional here either: a seeded note that reaches an
      // export with none has no identity to carry, and the collection it lands
      // in cannot match it on the way back (CARDS.md §4.5).
      sql: `INSERT INTO notes (id, guid, note_type, deck_id, fields, tags, fma_id, checksum, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?)`,
      params: [noteId, newGuid(), nt.id, note.deck, JSON.stringify(note.fields),
               (note.tags ?? []).join(' '), note.fma ?? null,
               fieldChecksum(firstFieldOf(nt.fields, note.fields)), now],
    })
    for (const ord of generatedOrds(nt, note.fields))
      stmts.push({ sql: INSERT_CARD, params: insertParams(newCard(cardId(noteId, ord), noteId, ord, now)) })
  }

  await db.batch(stmts)
}

// ── import (Phase 4) ──────────────────────────────────────────────────────

export interface ImportedReview {
  ord: number
  ts: number
  rating: RatingValue
  durationMs: number
}

export interface ImportedNote {
  /** Anki's guid, carried verbatim — this is what makes a re-import an update. */
  guid: string
  noteTypeId: string
  deckId: string
  fields: Record<string, string>
  tags: string[]
  mod: number
  /** Per-ordinal deck, when a card does not live in its note's deck. */
  cardDecks: Record<number, string | null>
  reviews: ImportedReview[]
}

/**
 * Write a batch of imported notes, their cards and their history.
 *
 * Not `saveNote` in a loop: that resolves the note types and queries the review
 * log once per note, which is four round trips through the worker for each of
 * 20,000 notes. This does four for the whole batch and computes the rest here.
 *
 * Matching is **on guid, never on content** (CARDS.md §4.5). A note that is
 * already here keeps its id, its cards and their scheduling; only its fields,
 * tags and deck are brought up to date. That is what makes a shared deck
 * publishable as v2 instead of as 4,000 duplicates.
 */
export async function importNotes(
  batch: ImportedNote[],
  types: NoteType[],
  now = Date.now(),
): Promise<{ added: number; updated: number }> {
  if (!batch.length) return { added: 0, updated: 0 }
  const byId = new Map(types.map((t) => [t.id, t]))

  const holes = batch.map(() => '?').join(',')
  const known = new Map(
    (await db.select<{ id: string; guid: string }>(
      `SELECT id, guid FROM notes WHERE guid IN (${holes})`,
      batch.map((n) => n.guid),
    )).map((r) => [r.guid, r.id]),
  )

  const resolved = batch.map((n) => ({ note: n, id: known.get(n.guid) ?? id() }))
  const noteIds = resolved.map((r) => r.id)

  // Everything this batch could touch, in two queries rather than 2n.
  const existing = await db.select<{ id: string; note_id: string; ord: number }>(
    `SELECT id, note_id, ord FROM cards WHERE note_id IN (${noteIds.map(() => '?').join(',')})`,
    noteIds,
  )
  const priorLog = await db.select<Review>(
    `SELECT r.* FROM reviews r JOIN cards c ON c.id = r.card_id
      WHERE c.note_id IN (${noteIds.map(() => '?').join(',')}) ORDER BY r.ts`,
    noteIds,
  )
  const retention = new Map(
    (await db.select<{ id: string; retention_target: number }>(
      'SELECT id, retention_target FROM decks',
    )).map((d) => [d.id, d.retention_target])
  )

  const stmts: { sql: string; params?: unknown[] }[] = []
  let added = 0

  for (const { note, id: noteId } of resolved) {
    const nt = byId.get(note.noteTypeId)
    if (!nt) continue
    if (!known.has(note.guid)) added++

    stmts.push({
      sql: `INSERT INTO notes (id, guid, note_type, deck_id, fields, tags, fma_id, checksum, updated_at)
            VALUES (?,?,?,?,?,?,NULL,?,?)
            ON CONFLICT(id) DO UPDATE SET
              note_type = excluded.note_type, deck_id = excluded.deck_id,
              fields = excluded.fields, tags = excluded.tags,
              checksum = excluded.checksum, updated_at = excluded.updated_at`,
      params: [noteId, note.guid, nt.id, note.deckId, JSON.stringify(note.fields),
               note.tags.join(' '), fieldChecksum(firstFieldOf(nt.fields, note.fields)), note.mod],
    })

    // A review id derived from the card and the timestamp, so importing the
    // same deck twice inserts the same rows twice and the log does not double.
    //
    // The id alone is not enough, though: a review this device *recorded* has a
    // random id, and the same answer coming back through an export would be a
    // second row for one moment in time. An answer is identified by its card
    // and its instant, so that pair is what the log is deduplicated on — and it
    // is what makes export → re-import leave the review count unchanged.
    const already = new Set(priorLog.map((r) => `${r.card_id}@${r.ts}`))
    const mine: Review[] = note.reviews
      .filter((r) => !already.has(`${cardId(noteId, r.ord)}@${r.ts}`))
      .map((r) => ({
        id: `${cardId(noteId, r.ord)}@${r.ts}`,
        card_id: cardId(noteId, r.ord),
        ts: r.ts,
        rating: r.rating,
        duration_ms: r.durationMs,
      }))
    for (const r of mine)
      stmts.push({
        sql: `INSERT INTO reviews (id, card_id, ts, rating, duration_ms, synced, imported)
              VALUES (?,?,?,?,?,0,1) ON CONFLICT(id) DO NOTHING`,
        params: [r.id, r.card_id, r.ts, r.rating, r.duration_ms],
      })

    const want = generatedOrds(nt, note.fields)
    const have = existing.filter((c) => c.note_id === noteId)
    const log = [...priorLog.filter((r) => r.card_id.startsWith(`${noteId}:`)), ...mine]

    for (const ord of want) {
      const cid = cardId(noteId, ord)
      const deckOverride = note.cardDecks[ord] ?? overrideOf(nt, ord)
      const own = log.filter((r) => r.card_id === cid).sort((a, b) => a.ts - b.ts)
      const rate = retention.get(deckOverride ?? note.deckId) ?? 0.9

      if (!own.length) {
        // No history on either side: leave a card that is already here alone,
        // because its scheduling is the user's and the import knows nothing
        // about it.
        if (have.some((h) => h.ord === ord)) continue
        stmts.push({ sql: INSERT_CARD, params: insertParams(newCard(cid, noteId, ord, now), deckOverride) })
        continue
      }
      // Replaying the whole log rather than trusting Anki's interval is the
      // point of PHASES.md's "let FSRS re-derive stability": its numbers come
      // from a different algorithm, and the answers are what both agree on.
      const card = replayReviews({ id: cid, note_id: noteId, ord }, own, rate, own[0]!.ts)
      stmts.push(
        have.some((h) => h.ord === ord)
          ? { sql: UPDATE_CARD_DECK, params: [...updateParams(card).slice(0, -1), deckOverride, cid] }
          : { sql: INSERT_CARD, params: insertParams(card, deckOverride) },
      )
    }

    for (const h of have)
      if (!want.includes(h.ord))
        stmts.push({ sql: 'DELETE FROM cards WHERE id = ?', params: [h.id] })
  }

  await db.batch(stmts)
  return { added, updated: batch.length - added }
}

// ── export (Phase 4) ──────────────────────────────────────────────────────

export interface ExportRow {
  note: Note & { guid: string }
  cards: (Card & { deckId: string })[]
  reviews: Review[]
}

/**
 * Everything an `.apkg` needs, for a deck subtree or the whole collection.
 *
 * Three queries rather than one join: a note has many cards and a card has many
 * reviews, so a single result set would repeat every note's fields once per
 * review — which on a collection with real history is most of the memory in
 * the export.
 *
 * ponytail: the whole collection is read into memory at once. That is fine up
 * to a few hundred thousand reviews; page it by deck the day someone's export
 * runs the tab out of memory.
 */
export async function collectionForExport(deckId?: string | null): Promise<ExportRow[]> {
  const scope = deckId
    ? `WHERE ${DECK_OF} IN (
         WITH RECURSIVE sub(id) AS (
           SELECT ? UNION ALL SELECT d.id FROM decks d JOIN sub ON d.parent_id = sub.id
         ) SELECT id FROM sub)`
    : ''
  const params = deckId ? [deckId] : []

  const cards = await db.select<CardRow & { deck: string }>(
    `SELECT c.*, ${DECK_OF} AS deck FROM cards c JOIN notes n ON n.id = c.note_id ${scope}`,
    params,
  )
  if (!cards.length) return []

  const noteIds = [...new Set(cards.map((c) => c.note_id))]
  const holes = noteIds.map(() => '?').join(',')
  const notes = await db.select<any>(`SELECT * FROM notes WHERE id IN (${holes})`, noteIds)
  const reviews = await db.select<Review>(
    `SELECT r.* FROM reviews r WHERE r.card_id IN (${cards.map(() => '?').join(',')}) ORDER BY r.ts`,
    cards.map((c) => c.id),
  )

  return notes.map((r): ExportRow => {
    const mine = cards.filter((c) => c.note_id === r.id)
    return {
      note: {
        id: r.id, guid: r.guid, note_type: r.note_type, deck_id: r.deck_id,
        fields: JSON.parse(r.fields),
        tags: r.tags ? String(r.tags).split(' ').filter(Boolean) : [],
        fma_id: r.fma_id, updated_at: r.updated_at,
      },
      cards: mine.map((c) => ({ ...toCard(c), deckId: c.deck })),
      reviews: reviews.filter((rev) => mine.some((c) => c.id === rev.card_id)),
    }
  })
}

/** Deck id → its `A::B::C` path, which is how Anki spells a deck tree. */
export async function deckPaths(): Promise<Map<string, string>> {
  const rows = await db.select<{ id: string; path: string }>(
    `WITH RECURSIVE tree(id, path) AS (
       SELECT id, name FROM decks WHERE parent_id IS NULL
       UNION ALL
       SELECT d.id, t.path || '::' || d.name FROM decks d JOIN tree t ON d.parent_id = t.id
     ) SELECT id, path FROM tree`,
  )
  return new Map(rows.map((r) => [r.id, r.path]))
}
