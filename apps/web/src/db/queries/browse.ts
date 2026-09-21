/**
 * Everything the global card browser reads and writes.
 *
 * One rule shapes the whole module: **a count is a promise** (README, rule 4).
 * The number in the header, the rows on screen and the rows a bulk operation
 * touches are produced by the same compiled search — never by "what is in the
 * list right now", which is a page of a hundred out of forty thousand.
 */
import { db } from '../client.ts'
import { replayCards } from './replay.ts'
import { DECK_OF, clozeText, searchSql, stripHtml, type Term } from '@recall/core'

const DAY = 86_400_000

export interface BrowseCard {
  id: string
  note_id: string
  ord: number
  due: number
  state: string
  lapses: number
  reps: number
  flag: number
  suspended: boolean
  buried_until: number | null
  tags: string[]
  deck_id: string
  deck_name: string
  /** The note's sort field, stripped — what the row shows. */
  preview: string
  template: string
}

/** Sortable columns, whitelisted: the only part of the query not bound. */
export const SORTS = {
  due: 'c.due',
  state: `CASE c.state WHEN 'new' THEN 0 WHEN 'learning' THEN 1 WHEN 'relearning' THEN 2 ELSE 3 END`,
  lapses: 'c.lapses',
  reps: 'c.reps',
  flag: 'c.flag',
  deck: 'd.name',
  created: 'n.created_at',
  card: 'c.ord',
} as const
export type SortKey = keyof typeof SORTS

const FROM = `
  FROM cards c
  JOIN notes n ON n.id = c.note_id
  JOIN note_types t ON t.id = n.note_type
  JOIN decks d ON d.id = ${DECK_OF}`

/** The compiled predicate, plus the extra clause a single operation adds. */
function where(terms: Term[], extra?: string, now = Date.now()) {
  const { sql, params } = searchSql(terms, now)
  return { sql: extra ? `(${sql}) AND ${extra}` : sql, params }
}

export async function browseCount(terms: Term[], extra?: string): Promise<number> {
  const w = where(terms, extra)
  const [r] = await db.select<{ n: number }>(`SELECT COUNT(*) AS n ${FROM} WHERE ${w.sql}`, w.params)
  return r?.n ?? 0
}

/**
 * One page of rows.
 *
 * Paged, not virtualised: sorting and filtering are already in SQL, so a page
 * is one `LIMIT`/`OFFSET` and the DOM never holds more than `limit` rows —
 * no scroll-position maths, no measurement pass, no dependency.
 *
 * ponytail: `OFFSET` scans the rows it skips, so page 200 of a 40k-card search
 * costs a 20k-row walk. Switch to a keyset cursor on (sort column, id) when
 * anyone actually pages that deep; nobody reaches page 200 by scrolling.
 */
export async function browseCards(
  terms: Term[],
  sort: SortKey = 'due',
  dir: 'asc' | 'desc' = 'asc',
  limit = 100,
  offset = 0,
): Promise<BrowseCard[]> {
  const w = where(terms)
  const rows = await db.select<Record<string, any>>(
    `SELECT c.id, c.note_id, c.ord, c.due, c.state, c.lapses, c.reps, c.flag,
            c.suspended, c.buried_until,
            n.tags, n.fields, n.updated_at,
            t.fields AS nt_fields, t.sort_field AS nt_sort, t.templates AS nt_templates,
            d.id AS deck_id, d.name AS deck_name
     ${FROM}
      WHERE ${w.sql}
      ORDER BY ${SORTS[sort]} ${dir === 'desc' ? 'DESC' : 'ASC'}, c.id
      LIMIT ? OFFSET ?`,
    [...w.params, limit, offset],
  )
  return rows.map(toBrowseCard)
}

function toBrowseCard(r: Record<string, any>): BrowseCard {
  const fields: Record<string, string> = JSON.parse(r.fields)
  const names: string[] = JSON.parse(r.nt_fields)
  const chosen = fields[names[r.nt_sort ?? 0] ?? ''] ?? ''
  const sortValue = stripHtml(chosen).trim()
    ? chosen
    : (Object.values(fields).find((v) => stripHtml(v).trim()) ?? '')
  const templates: { name: string }[] = JSON.parse(r.nt_templates)
  return {
    id: r.id,
    note_id: r.note_id,
    ord: r.ord,
    due: r.due,
    state: r.state,
    lapses: r.lapses,
    reps: r.reps,
    flag: r.flag,
    suspended: !!r.suspended,
    buried_until: r.buried_until,
    tags: r.tags ? String(r.tags).split(' ').filter(Boolean) : [],
    deck_id: r.deck_id,
    deck_name: r.deck_name,
    // Cloze deletions unwrapped: a list is for finding the note, and
    // `{{c1::…}}` on every row is noise. Same choice as `repo.notesInDeck`.
    preview: clozeText(stripHtml(sortValue)).trim(),
    template: templates[r.ord]?.name ?? `Card ${r.ord + 1}`,
  }
}

// ── the tag sidebar ───────────────────────────────────────────────────────

export interface TagNode {
  /** Full tag, `anatomy::thorax::valves`. */
  tag: string
  /** Last component — what the row shows. */
  label: string
  depth: number
  /** Cards on notes carrying this tag **or any tag beneath it**. */
  cards: number
  children: TagNode[]
}

/** `marked` is a per-note bookmark; `leech` is written by the scheduler. */
export const RESERVED_TAGS = ['marked', 'leech'] as const

/**
 * The hierarchy, rolled up.
 *
 * Grouped by the whole tag *string* first, so a collection with 40k notes and
 * 300 distinct tag combinations comes back as 300 rows and the splitting
 * happens once per combination rather than once per note.
 *
 * Counts are cards, not notes, because the list next to it counts cards — a
 * sidebar that says 212 and a list that then says 407 is rule 4 broken in the
 * smallest possible way.
 */
export async function tagTree(): Promise<TagNode[]> {
  const rows = await db.select<{ tags: string; n: number }>(
    `SELECT n.tags, COUNT(*) AS n
       FROM notes n JOIN cards c ON c.note_id = n.id
      WHERE n.tags != '' GROUP BY n.tags`,
  )

  const counts = new Map<string, number>()
  for (const r of rows) {
    for (const tag of new Set(r.tags.split(' ').filter(Boolean))) {
      // Every ancestor gets the count too: `anatomy` holds what is under
      // `anatomy::thorax` even when no note carries the bare tag.
      const parts = tag.split('::')
      for (let i = 1; i <= parts.length; i++) {
        const key = parts.slice(0, i).join('::')
        counts.set(key, (counts.get(key) ?? 0) + r.n)
      }
    }
  }

  const roots: TagNode[] = []
  const nodes = new Map<string, TagNode>()
  for (const tag of [...counts.keys()].sort()) {
    const parts = tag.split('::')
    const node: TagNode = {
      tag,
      label: parts[parts.length - 1]!,
      depth: parts.length - 1,
      cards: counts.get(tag)!,
      children: [],
    }
    nodes.set(tag, node)
    const parent = nodes.get(parts.slice(0, -1).join('::'))
    ;(parent ? parent.children : roots).push(node)
  }
  return roots.filter((n) => !(RESERVED_TAGS as readonly string[]).includes(n.tag))
}

// ── bulk operations ───────────────────────────────────────────────────────

/**
 * What a bulk operation acts on.
 *
 * `ids` is an explicit tick-box selection. `search` is "select all matching",
 * and it is the whole reason this is a union: 4,000 cards cannot be carried as
 * 4,000 ids through a filter change, and re-running the search at write time
 * is what makes the count on the button the count that changes.
 */
export type Target = { ids: string[] } | { terms: Term[] }

const targetWhere = (t: Target, extra?: string) =>
  'ids' in t
    ? { sql: `c.id IN (${t.ids.map(() => '?').join(',') || 'NULL'})${extra ? ` AND ${extra}` : ''}`, params: t.ids }
    : where(t.terms, extra)

/** How many cards a bulk operation would touch — the number on the button. */
export async function targetCount(t: Target, extra?: string): Promise<number> {
  if ('ids' in t && !extra) return t.ids.length
  const w = targetWhere(t, extra)
  const [r] = await db.select<{ n: number }>(`SELECT COUNT(*) AS n ${FROM} WHERE ${w.sql}`, w.params)
  return r?.n ?? 0
}

/** Undo a bulk operation by putting back exactly the rows it changed. */
export interface Undo {
  label: string
  count: number
  /** Retag writes notes, everything else writes cards — say which was meant. */
  noun: 'card' | 'note'
  run: () => Promise<void>
  /**
   * `false` when the operation genuinely cannot be taken back, which is only
   * ever delete. The toast reads this and offers no button, because an Undo
   * that does nothing is worse than none: it is a promise, and somebody will
   * rely on it exactly once.
   */
  undoable?: boolean
}

/**
 * Read, change in JS, write back — and keep the "before" rows as the undo.
 *
 * The write is a single statement either way: SQLite joins `json_each` over
 * one JSON parameter against the primary key. That is what buys undo for free,
 * because the snapshot and the update are literally the same call.
 *
 * ponytail: a 40k-card operation ships ~2 MB of JSON through the worker each
 * way. Measured against the alternative — a set-based `UPDATE … WHERE id IN
 * (subquery)` with no undo — the JSON is worth it. Chunk it if a single
 * operation ever takes longer than the toast it raises.
 */
async function apply<T extends Record<string, unknown>>(
  table: 'cards' | 'notes',
  cols: string[],
  select: string,
  w: { sql: string; params: unknown[] },
  next: (row: T) => T | null,
  label: string,
): Promise<Undo> {
  const noun = table === 'notes' ? 'note' : 'card'
  const before = await db.select<T>(`SELECT DISTINCT ${select} ${FROM} WHERE ${w.sql}`, w.params)
  // Rows the operation would not change are dropped from both sides, so the
  // count reports what moved and undo does not rewrite rows it never touched.
  const moved = before.flatMap((r) => {
    const after = next(r)
    return after ? [{ before: r, after }] : []
  })
  await write(table, cols, moved.map((m) => m.after))
  return {
    label,
    count: moved.length,
    noun,
    run: () => write(table, cols, moved.map((m) => m.before)),
  }
}

function write(table: 'cards' | 'notes', cols: string[], rows: Record<string, unknown>[]) {
  if (!rows.length) return Promise.resolve()
  return db.run(
    `UPDATE ${table} SET ${cols.map((c) => `${c} = json_extract(j.value, '$.${c}')`).join(', ')}
       FROM json_each(?) j
      WHERE ${table}.id = json_extract(j.value, '$.id')`,
    [JSON.stringify(rows)],
  )
}

type CardState = { id: string; suspended: number; flag: number; deck_id: string | null; state_updated_at: number }
const CARD_STATE_COLS = ['suspended', 'flag', 'deck_id', 'state_updated_at']
const CARD_STATE_SELECT = 'c.id, c.suspended, c.flag, c.deck_id, c.state_updated_at'

export const bulkSuspend = (t: Target, suspended: boolean, now = Date.now()): Promise<Undo> =>
  apply<CardState>('cards', CARD_STATE_COLS, CARD_STATE_SELECT, targetWhere(t),
    (r) => (!!r.suspended === suspended ? null : { ...r, suspended: suspended ? 1 : 0, state_updated_at: now }),
    suspended ? 'Suspended' : 'Unsuspended')

export const bulkFlag = (t: Target, flag: number, now = Date.now()): Promise<Undo> =>
  apply<CardState>('cards', CARD_STATE_COLS, CARD_STATE_SELECT, targetWhere(t),
    (r) => (r.flag === flag ? null : { ...r, flag, state_updated_at: now }),
    flag ? 'Flagged' : 'Flag cleared')

/**
 * Move cards between decks by setting the card's **deck override**.
 *
 * Not `notes.deck_id`: a note's cards can legitimately live in different decks
 * (a reversed template sending its card to a "Recognition" deck), and moving
 * the note would drag its siblings along. The override is also what syncs, as
 * part of `card_states`.
 */
export const bulkMove = (t: Target, deckId: string, now = Date.now()): Promise<Undo> =>
  apply<CardState>('cards', CARD_STATE_COLS, CARD_STATE_SELECT, targetWhere(t),
    (r) => (r.deck_id === deckId ? null : { ...r, deck_id: deckId, state_updated_at: now }),
    'Moved')

/** Reschedule never touches a new card — see `bulkReschedule`. */
export const RESCHEDULABLE = `c.state != 'new'`

type CardSchedule = {
  id: string; due: number; state: string; due_override: number | null
  forgotten_at: number | null; state_updated_at: number
}
const SCHEDULE_COLS = ['due', 'due_override', 'forgotten_at', 'state_updated_at']
const SCHEDULE_SELECT =
  'c.id, c.due, c.state, c.due_override, c.forgotten_at, c.state_updated_at'

/**
 * Write the override *and* the cache it implies, in one pass.
 *
 * `due` is written here rather than left to a replay, and that is deliberate.
 * A due date only ever changes `due`, so folding the whole log to discover that
 * would be expensive and — worse — destructive: a card whose local log is
 * incomplete (an import with no revlog, a device mid-first-sync) would come
 * back from the fold as new. `replayReviews` still applies the override, which
 * is what keeps the two in agreement the next time something does rebuild.
 *
 * Forgetting is the exception and gets `replayCards`, because resetting the
 * card *is* the operation — see `bulkForget`.
 */
const overrideMany = (
  t: Target,
  next: (row: CardSchedule) => CardSchedule | null,
  label: string,
): Promise<Undo> =>
  apply<CardSchedule>('cards', SCHEDULE_COLS, SCHEDULE_SELECT,
    targetWhere(t, RESCHEDULABLE), next, label)

/**
 * Set a card's next due date, `days` from now.
 *
 * **It writes `cards.due` and nothing else. It does not append to `reviews`,
 * and it must not** (README, rule 1): a date someone picked is not an answer
 * someone gave, and minting a rating to carry it would poison every retention
 * number and every FSRS optimisation that reads the log afterwards.
 *
 * The honest consequence, stated rather than hidden: `cards` is a derived
 * cache, so `replayReviews()` rebuilds `due` from the log and a manual date is
 * rebuilt away. Today only `repo.undoLast` replays, and only for the one card
 * it just changed, so this holds in practice — but it is the one write in the
 * app that puts something in the cache with no source in the log.
 *
 * ponytail: the durable answer is a small table of scheduling overrides that
 * `replayReviews` applies last. Build it when replay starts running across the
 * whole collection (FSRS re-optimisation), not before — an override table that
 * nothing reads back is just a second place for the date to be wrong.
 *
 * New cards are excluded rather than silently ignored: `nextCard` orders new
 * cards ahead of `due` entirely, so writing one a date would change nothing
 * while the confirmation said it had. The dialog counts with the same clause.
 */
export const bulkReschedule = (t: Target, days: number, now = Date.now()): Promise<Undo> =>
  overrideMany(t,
    (r) => ({ ...r, due: now + days * DAY, due_override: now + days * DAY, state_updated_at: now }),
    'Rescheduled')

/**
 * Push a card's existing date further out, or pull it in — relative, not absolute.
 *
 * This is the one scheduling operation Anki core still does not have (its users
 * install FSRS Helper for it), and the reason it is worth having is that a
 * backlog is not fixed by giving four thousand cards the *same* new date. Each
 * card keeps its own position in the queue and the whole queue slides.
 *
 * Advancing is clamped to today: a date in the past would put the card at the
 * front of the queue in an order nobody chose.
 */
export const bulkShift = (t: Target, days: number, now = Date.now()): Promise<Undo> =>
  overrideMany(t,
    (r) => {
      const due = Math.max(now, r.due + days * DAY)
      return { ...r, due, due_override: due, state_updated_at: now }
    },
    days >= 0 ? 'Postponed' : 'Advanced')

/**
 * Forget: back to new, keeping every answer in the log.
 *
 * See `repo.forget` for why this cannot delete history and does not need to.
 * New cards are skipped because there is nothing to forget, and saying so in
 * the count is better than reporting work that did not happen.
 */
export async function bulkForget(t: Target, now = Date.now()): Promise<Undo> {
  const ids = (await db.select<{ id: string }>(
    `SELECT DISTINCT c.id ${FROM} WHERE ${targetWhere(t, RESCHEDULABLE).sql}`,
    targetWhere(t, RESCHEDULABLE).params,
  )).map((r) => r.id)

  const undo = await overrideMany(t,
    (r) => ({ ...r, forgotten_at: now, due_override: null, state_updated_at: now }),
    'Forgotten')

  // Unlike a date, a forget changes state, reps and lapses, so the cache really
  // does have to be refolded — and the undo has to refold it back, or half the
  // selection stays new after the toast says it did not.
  await replayCards(ids)
  return { ...undo, run: () => undo.run().then(() => replayCards(ids)) }
}

/**
 * Add or remove one tag across the selection.
 *
 * Tags live on notes, so this reaches wider than the selected cards: ticking
 * one card of a two-card note tags both. That is Anki's behaviour and the only
 * coherent one — a tag that applied to half a note would have nowhere to live.
 */
export const bulkRetag = (t: Target, tag: string, add: boolean, now = Date.now()): Promise<Undo> =>
  apply<{ id: string; tags: string; updated_at: number }>('notes', ['tags', 'updated_at'],
    'n.id, n.tags, n.updated_at', targetWhere(t),
    (r) => {
      const tags = r.tags.split(' ').filter(Boolean)
      if (add === tags.includes(tag)) return null
      const next = add ? [...tags, tag] : tags.filter((x) => x !== tag)
      return { ...r, tags: next.sort().join(' '), updated_at: now }
    },
    add ? `Tagged ${tag}` : `Untagged ${tag}`)


// ── find and replace, and delete ──────────────────────────────────────────

export interface ReplaceSpec {
  find: string
  replace: string
  /** One field, or every field when null. */
  field: string | null
  regex: boolean
  matchCase: boolean
}

/**
 * Find and replace across the fields of the selected notes.
 *
 * Anki has had this forever and it is how a 20,000-card import gets fixed: a
 * stray `<br>`, a wrong abbreviation, a tag that should have been a word. It
 * writes notes rather than cards, so like retag it reaches every card of a
 * note that had one card selected — which is the only coherent behaviour,
 * since a field cannot be half-replaced.
 *
 * It runs through `apply`, so it is undoable in one click, and that is what
 * makes it safe to offer at all on an operation this blunt.
 */
export function bulkReplace(t: Target, spec: ReplaceSpec, now = Date.now()): Promise<Undo> {
  const pattern = compileReplace(spec)

  return apply<{ id: string; fields: string; checksum: number | null; updated_at: number }>(
    'notes', ['fields', 'updated_at'], 'n.id, n.fields, n.checksum, n.updated_at',
    targetWhere(t),
    (r) => {
      let parsed: Record<string, string>
      try {
        parsed = JSON.parse(r.fields) as Record<string, string>
      } catch {
        // A note whose fields will not parse is already broken; rewriting it
        // from a regex would turn a readable problem into an unreadable one.
        return null
      }

      let changed = false
      const next: Record<string, string> = {}
      for (const [name, value] of Object.entries(parsed)) {
        if (spec.field !== null && name !== spec.field) {
          next[name] = value
          continue
        }
        const after = value.replace(pattern, spec.replace)
        if (after !== value) changed = true
        next[name] = after
      }

      return changed ? { ...r, fields: JSON.stringify(next), updated_at: now } : null
    },
    'Replaced in',
  )
}

/**
 * The pattern, whether it was typed as one or not.
 *
 * A literal search is escaped rather than run, so `$1` in the replacement of a
 * non-regex search is still `$1` — and `.` matches a full stop. Always global:
 * replacing the first `<br>` in a field and leaving the other four is not what
 * anybody means.
 */
function compileReplace(spec: ReplaceSpec): RegExp {
  const body = spec.regex ? spec.find : spec.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(body, spec.matchCase ? 'g' : 'gi')
}

/** How many notes a replace would touch, for the dialog to say before it runs. */
export async function replaceCount(t: Target, spec: ReplaceSpec): Promise<number> {
  const pattern = compileReplace(spec)
  const rows = await db.select<{ fields: string }>(
    `SELECT DISTINCT n.id, n.fields ${FROM} WHERE ${targetWhere(t).sql}`, targetWhere(t).params,
  )
  return rows.filter((r) => {
    try {
      const parsed = JSON.parse(r.fields) as Record<string, string>
      return Object.entries(parsed).some(([name, value]) =>
        (spec.field === null || name === spec.field) && pattern.test(value))
    } catch {
      return false
    } finally {
      // `g` regexes carry `lastIndex` between calls, so a shared one skips
      // every other row. Resetting is cheaper than compiling per row.
      pattern.lastIndex = 0
    }
  }).length
}

/**
 * Delete the selected notes, and every card and tombstone that implies.
 *
 * **Not undoable, and it says so** — see `Undo.undoable`. The review log is
 * left alone: it is append-only, the rows are orphaned rather than wrong, and
 * a note that comes back by the same guid from an import finds its history
 * again. That is the same reasoning as `repo.deleteNote`, which this is the
 * bulk form of.
 */
export async function bulkDelete(t: Target, now = Date.now()): Promise<Undo> {
  const w = targetWhere(t)
  const notes = (await db.select<{ id: string }>(
    `SELECT DISTINCT n.id ${FROM} WHERE ${w.sql}`, w.params,
  )).map((r) => r.id)
  if (!notes.length) return { label: 'Deleted', count: 0, noun: 'note', run: async () => {}, undoable: false }

  const ids = holes(notes.length)
  await db.batch([
    // Tombstones first: they read the rows that are about to go.
    {
      sql: `INSERT INTO tombstones (resource, key, deleted_at, synced)
            SELECT 'card_states', id, ?, 0 FROM cards WHERE note_id IN (${ids})
            ON CONFLICT(resource, key) DO UPDATE SET deleted_at = excluded.deleted_at, synced = 0`,
      params: [now, ...notes],
    },
    {
      sql: `INSERT INTO tombstones (resource, key, deleted_at, synced)
            SELECT 'notes', id, ?, 0 FROM notes WHERE id IN (${ids})
            ON CONFLICT(resource, key) DO UPDATE SET deleted_at = excluded.deleted_at, synced = 0`,
      params: [now, ...notes],
    },
    { sql: `DELETE FROM cards WHERE note_id IN (${ids})`, params: notes },
    { sql: `DELETE FROM notes WHERE id IN (${ids})`, params: notes },
  ])

  return { label: 'Deleted', count: notes.length, noun: 'note', run: async () => {}, undoable: false }
}

const holes = (n: number) => Array.from({ length: n }, () => '?').join(',')
