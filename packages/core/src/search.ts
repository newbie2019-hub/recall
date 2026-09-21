/**
 * The search string: `deck:Anatomy tag:thorax is:due -flag:1 mitral`.
 *
 * A tokeniser and a flat list of ANDed terms — deliberately not a query
 * language. No OR, no parentheses, no nesting. Anki has them and almost nobody
 * writes them, and the moment they exist the UI can no longer round-trip a
 * search through clickable facets, which is how it is actually driven.
 *
 * It lives in core rather than in the browser screen because three callers
 * need the same string to mean the same thing: the global browser (Phase 6),
 * a filtered deck's saved search (Phase 7) and the mobile app (Phase 12). A
 * search that selects 340 cards on the desktop and 341 on the phone is the
 * same broken promise as a deck badge that lies (README, rule 4).
 */

export type TermKind =
  | 'deck' | 'tag' | 'is' | 'flag' | 'lapses' | 'due' | 'text'
  | 'prop' | 'added' | 'rated' | 'nid' | 're'

export interface Term {
  kind: TermKind
  /** Already validated against the kind — `searchSql` never re-checks it. */
  value: string
  neg: boolean
}

/**
 * A card's deck, which is the note's deck unless a template overrides it.
 *
 * Spelled identically in `repo.ts`; every deck-scoped query has to agree or
 * the badges and the study loop drift apart.
 */
export const DECK_OF = 'COALESCE(c.deck_id, n.deck_id)'

export const CARD_STATES = ['new', 'learning', 'review', 'relearning'] as const

/** `is:` values. `marked` and `leech` are reserved tags, not card columns. */
const IS_VALUES = new Set<string>([
  ...CARD_STATES, 'due', 'suspended', 'buried', 'flagged', 'marked', 'leech',
])

/**
 * `prop:r` is a question about the forgetting curve, and `memory.ts` owns it.
 *
 * ⚠️ Its shape is not a constant of the universe: FSRS-6 trains `decay` as a
 * weight. Importing rather than writing a number down is what keeps a search
 * from silently disagreeing with the scheduler.
 */
import { daysUntil } from './memory.ts'

const LAPSES = /^(>=|<=|>|<|=)?(\d{1,6})$/
const DAYS = /^-?\d{1,5}$/
const DAY_MS = 86_400_000

/**
 * `prop:` — a comparison against one numeric property of a card.
 *
 * Anki's spelling, because anybody who has one of its searches written down
 * should be able to paste it. The properties are whitelisted here and mapped to
 * SQL below; anything else falls through to plain text like any other prefix
 * that does not validate, which is how someone typing `prop:eas>2` finds out.
 *
 * `r` is the odd one: retrievability is not a column, it is the forgetting
 * curve evaluated now, so it compiles to arithmetic rather than a comparison.
 */
const PROPS = {
  ivl: 'interval in days',
  due: 'days until due',
  reps: 'times answered',
  lapses: 'times failed',
  s: 'stability in days',
  d: 'difficulty, 1-10',
  r: 'predicted recall, 0-1',
} as const

const PROP = /^([a-z]+)(>=|<=|!=|>|<|=)(-?\d+(?:\.\d+)?)$/

/** `rated:7` — answered in the last week. `rated:7:1` — *failed* in it. */
const RATED = /^(\d{1,5})(?::([1-4]))?$/

/** `added:30` — created in the last thirty days. */
const ADDED = /^\d{1,5}$/

/**
 * Quoted runs survive whitespace, so `tag:"needs work"` is one token. The
 * prefix is allowed outside the quotes because that is how everyone types it.
 */
const TOKEN = /-?(?:[a-z]+:)?"[^"]*"|\S+/gi

export function parseSearch(input: string): Term[] {
  const terms: Term[] = []
  for (const raw of input.match(TOKEN) ?? []) {
    const neg = raw.startsWith('-')
    const body = neg ? raw.slice(1) : raw
    const colon = body.indexOf(':')
    const prefix = colon > 0 ? body.slice(0, colon).toLowerCase() : ''
    const value = unquote(colon > 0 ? body.slice(colon + 1) : body)
    if (!value) continue

    // A prefix that does not validate falls back to plain text rather than
    // being dropped: someone typing `is:dur` should see no results *and* see
    // why, not silently get the whole collection back.
    const kind = term(prefix, value)
    terms.push(kind ? { kind, value, neg } : { kind: 'text', value: unquote(body), neg })
  }
  return terms
}

function term(prefix: string, value: string): TermKind | null {
  switch (prefix) {
    case 'deck': return 'deck'
    case 'tag': return 'tag'
    case 'is': return IS_VALUES.has(value.toLowerCase()) ? 'is' : null
    case 'flag': return /^[0-7]$/.test(value) ? 'flag' : null
    case 'lapses': return LAPSES.test(value) ? 'lapses' : null
    case 'due': return DAYS.test(value) ? 'due' : null
    case 'prop': {
      const m = PROP.exec(value.toLowerCase())
      return m && m[1]! in PROPS ? 'prop' : null
    }
    case 'added': return ADDED.test(value) ? 'added' : null
    case 'rated': return RATED.test(value) ? 'rated' : null
    case 'nid': return value.length <= 64 ? 'nid' : null
    case 're': return isRegex(value) ? 're' : null
    case '': return 'text'
    default: return null
  }
}

/**
 * A regex that this engine will actually run, checked at parse time.
 *
 * Compiling it here means a typo is a search that finds nothing and says so,
 * rather than an exception from inside SQLite three frames down. It is also the
 * only validation that matters for safety: the pattern never reaches SQL — the
 * `re:` term filters in JS after the query, because SQLite has no REGEXP
 * without an extension.
 */
function isRegex(pattern: string): boolean {
  try {
    new RegExp(pattern, 'i')
    return true
  } catch {
    return false
  }
}

const unquote = (s: string) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s)

/** Back to a string, so the facet chips and the text box are the same state. */
export const formatSearch = (terms: Term[]): string =>
  terms.map(format).join(' ')

function format(t: Term): string {
  const quoted = /[\s"]/.test(t.value) ? `"${t.value.replace(/"/g, '')}"` : t.value
  return `${t.neg ? '-' : ''}${t.kind === 'text' ? '' : `${t.kind}:`}${quoted}`
}

/**
 * Set or clear a single-valued facet (state, flag) without disturbing the rest.
 * `null` removes it. Multi-valued kinds (`tag`, `text`) are appended by the
 * caller instead.
 */
export function setFacet(terms: Term[], kind: TermKind, value: string | null): Term[] {
  const rest = terms.filter((t) => t.kind !== kind)
  return value === null ? rest : [...rest, { kind, value, neg: false }]
}

export function hasTerm(terms: Term[], kind: TermKind, value: string): boolean {
  return terms.some((t) => t.kind === kind && !t.neg && t.value === value)
}

export interface SearchSql {
  /** A boolean expression over the aliases `c` (cards) and `n` (notes). */
  sql: string
  params: unknown[]
}

/**
 * Compile to SQL. The caller supplies the FROM clause, which must alias
 * `cards` as `c` and `notes` as `n`.
 *
 * Every value is a bound parameter — the only things interpolated are the
 * comparison operator and the state name, both matched against a literal
 * pattern in `parseSearch` before they get here.
 */
export function searchSql(terms: Term[], now = Date.now()): SearchSql {
  const params: unknown[] = []
  if (!terms.length) return { sql: '1', params }
  const parts = terms.map((t) => {
    const expr = compile(t, now, params)
    return t.neg ? `NOT (${expr})` : expr
  })
  return { sql: parts.join(' AND '), params }
}

function compile(t: Term, now: number, p: unknown[]): string {
  switch (t.kind) {
    case 'deck':
      p.push(t.value)
      // ponytail: matches a deck by its own name at any depth, so two decks
      // both called "Heart" under different parents both match. Take a full
      // `a::b` path when someone actually hits that collision.
      return `${DECK_OF} IN (
        WITH RECURSIVE sub(id) AS (
          SELECT id FROM decks WHERE name = ? COLLATE NOCASE
          UNION ALL SELECT d.id FROM decks d JOIN sub ON d.parent_id = sub.id)
        SELECT id FROM sub)`

    case 'tag':
      return tagSql(t.value, p)

    case 'is': {
      const v = t.value.toLowerCase()
      if (v === 'due') { p.push(now); return `(c.state != 'new' AND c.due <= ?)` }
      if (v === 'suspended') return 'c.suspended = 1'
      if (v === 'buried') { p.push(now); return '(c.buried_until IS NOT NULL AND c.buried_until > ?)' }
      if (v === 'flagged') return 'c.flag != 0'
      if (v === 'marked' || v === 'leech') return tagSql(v, p)
      p.push(v)
      return 'c.state = ?'
    }

    case 'flag':
      p.push(Number(t.value))
      return 'c.flag = ?'

    case 'lapses': {
      const [, op = '=', n] = LAPSES.exec(t.value)!
      p.push(Number(n))
      return `c.lapses ${op} ?`
    }

    case 'due':
      // `due:7` is "due within a week", `due:0` today, `due:-1` overdue
      // yesterday or earlier. New cards have no due date worth the name.
      p.push(now + Number(t.value) * DAY_MS)
      return `(c.state != 'new' AND c.due <= ?)`

    case 'prop':
      return propSql(t.value.toLowerCase(), now, p)

    case 'added':
      // Cards, not notes: the browser lists cards, and a note whose second
      // template started generating last week added a card last week.
      p.push(now - Number(t.value) * DAY_MS)
      return 'c.created_at >= ?'

    case 'rated': {
      const [, days, rating] = RATED.exec(t.value)!
      p.push(now - Number(days) * DAY_MS)
      if (rating) p.push(Number(rating))
      // Answers, not schedule: this is the one term that asks the log directly,
      // which is why it can still find a card that has since been forgotten.
      return `EXISTS (SELECT 1 FROM reviews rv WHERE rv.card_id = c.id AND rv.ts >= ?${
        rating ? ' AND rv.rating = ?' : ''})`
    }

    case 'nid':
      p.push(t.value)
      return 'c.note_id = ?'

    case 're':
      // Against the raw fields JSON, the same text `text:` sees. `REGEXP` is
      // registered on the connection in `db/worker.ts`; see there for why it
      // cannot be a filter over the results.
      p.push(t.value)
      return 'n.fields REGEXP ?'

    case 'text':
      // ponytail: matches the raw fields JSON, so it also matches HTML tag
      // names and hits nothing for text split by inline markup. A stripped
      // shadow column indexed with FTS5 is the fix, once someone complains.
      p.push(`%${esc(t.value)}%`)
      return `n.fields LIKE ? ESCAPE '\\'`
  }
}

/**
 * One numeric property of a card, compared.
 *
 * Three of the seven are not columns and are spelled out as arithmetic:
 * `ivl` and `due` are days rather than the milliseconds stored, and `r` is the
 * forgetting curve — `(1 + FACTOR·t/S)^DECAY` — evaluated at today's elapsed
 * days. The curve's constants are passed in rather than hard-coded so that the
 * one place they are derived stays `memory.ts`.
 */
function propSql(value: string, now: number, p: unknown[]): string {
  // Non-null throughout: `term()` ran this same pattern before the term was
  // accepted, so a `prop` term that reaches here matched all three groups.
  const m = PROP.exec(value)!
  const [key, op, n] = [m[1]!, m[2]!, m[3]!]
  const num = Number(n)

  switch (key as keyof typeof PROPS) {
    case 'reps': p.push(num); return `c.reps ${op} ?`
    case 'lapses': p.push(num); return `c.lapses ${op} ?`
    case 's': p.push(num); return `c.stability ${op} ?`
    case 'd': p.push(num); return `c.difficulty ${op} ?`

    case 'ivl':
      // The gap FSRS chose, which only exists once a card has been answered.
      p.push(num)
      return `(c.last_review IS NOT NULL AND (c.due - c.last_review) / 86400000.0 ${op} ?)`

    case 'due':
      p.push(now, num)
      return `(c.state != 'new' AND (c.due - ?) / 86400000.0 ${op} ?)`

    case 'r':
      return recallSql(op, num, now, p)
  }
}

/**
 * `prop:r` without evaluating the curve in SQL.
 *
 * The obvious compilation needs `POWER`, and SQLite only has the maths
 * functions when it was built with them — true of `node:sqlite`, not promised
 * by the wasm build this actually runs on. So the threshold is inverted in
 * JavaScript instead, which is exact rather than a workaround:
 *
 *     R(t,S) = (1 + F·t/S)^D  ≥ x   ⟺   t/S ≤ (x^(1/D) − 1)/F
 *
 * and the right-hand side is `daysUntil(1, x)` — the function `memory.ts`
 * already exports for "how long until recall falls to x". The comparison left
 * in SQL is then a multiplication.
 *
 * **The operator flips.** Recall *falls* as time passes, so a card with high
 * recall is one with a *short* elapsed time. Getting this backwards would
 * return precisely the cards you did not ask for, which is why it is a table
 * rather than a clever expression.
 */
function recallSql(op: string, target: number, now: number, p: unknown[]): string {
  // Recall is in (0, 1]. Anything outside that is asking about nothing, and
  // saying so as a constant beats a comparison that cannot be satisfied.
  if (target <= 0) return op === '>' || op === '>=' || op === '!=' ? '1' : '0'
  if (target > 1) return op === '<' || op === '<=' || op === '!=' ? '1' : '0'

  const elapsed = `((? - c.last_review) / 86400000.0)`
  const seen = `c.last_review IS NOT NULL AND c.stability > 0`

  // `=` on a float never matches, so it means "shows the same percentage",
  // which is the only reading that can be true of anything on screen.
  if (op === '=' || op === '!=') {
    const lo = daysUntil(1, Math.min(1, target + 0.005))
    const hi = daysUntil(1, Math.max(0.000001, target - 0.005))
    p.push(now, now)
    const band = `(${seen} AND ${elapsed} >= ${lo} * c.stability
                   AND ${elapsed} <= ${hi} * c.stability)`
    return op === '=' ? band : `NOT ${band}`
  }

  const k = daysUntil(1, target)
  const flipped = { '>=': '<=', '>': '<', '<=': '>=', '<': '>' }[op]!
  p.push(now)
  return `(${seen} AND ${elapsed} ${flipped} ${k} * c.stability)`
}

/**
 * `anatomy` matches `anatomy` and everything under `anatomy::`, because a tag
 * in the sidebar is a folder and clicking a folder that returned only its own
 * direct notes would be a lie about what is inside it.
 */
function tagSql(tag: string, p: unknown[]): string {
  p.push(`% ${esc(tag)} %`, `% ${esc(tag)}::%`)
  return `(' ' || n.tags || ' ' LIKE ? ESCAPE '\\' OR ' ' || n.tags || ' ' LIKE ? ESCAPE '\\')`
}

const esc = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`)
