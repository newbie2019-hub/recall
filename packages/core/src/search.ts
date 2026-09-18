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

export type TermKind = 'deck' | 'tag' | 'is' | 'flag' | 'lapses' | 'due' | 'text'

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

const LAPSES = /^(>=|<=|>|<|=)?(\d{1,6})$/
const DAYS = /^-?\d{1,5}$/
const DAY_MS = 86_400_000

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
    case '': return 'text'
    default: return null
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

    case 'text':
      // ponytail: matches the raw fields JSON, so it also matches HTML tag
      // names and hits nothing for text split by inline markup. A stripped
      // shadow column indexed with FTS5 is the fix, once someone complains.
      p.push(`%${esc(t.value)}%`)
      return `n.fields LIKE ? ESCAPE '\\'`
  }
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
