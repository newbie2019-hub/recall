/**
 * Anki's template language. Pure — no DOM, no React, no KaTeX.
 *
 * The web app paints the output into a sandboxed iframe and React Native will
 * paint it into a WebView; both call exactly this. It is the most
 * breakage-prone unit in the codebase, so its fixtures were written first
 * (`template.test.ts`).
 */
import { clozeAnswer, clozeOrds, renderCloze } from './cloze.ts'
import { typeAnswerHtml } from './diff.ts'
import { escapeHtml, isEmpty, stripHtml } from './html.ts'
import type { NoteType } from './notetypes.ts'
import { occlusionHtml, occlusionOrds } from './occlusion.ts'

type Node =
  | { t: 'text'; v: string }
  | { t: 'var'; filters: string[]; name: string }
  | { t: 'sec'; name: string; neg: boolean; body: Node[] }

const TOKEN = /\{\{([^{}]*)\}\}/g

export function parse(tmpl: string): Node[] {
  const root: Node[] = []
  const stack: Node[][] = [root]
  const top = () => stack[stack.length - 1]!
  let last = 0

  for (const m of tmpl.matchAll(TOKEN)) {
    const lit = tmpl.slice(last, m.index)
    if (lit) top().push({ t: 'text', v: lit })
    last = m.index + m[0].length

    const raw = m[1]!.trim()
    if (raw.startsWith('#') || raw.startsWith('^')) {
      const body: Node[] = []
      top().push({ t: 'sec', name: raw.slice(1).trim(), neg: raw[0] === '^', body })
      stack.push(body)
    } else if (raw.startsWith('/')) {
      // Unbalanced closers are ignored rather than thrown: an imported deck with
      // one broken template should render its other 4,000 cards.
      if (stack.length > 1) stack.pop()
    } else {
      const parts = raw.split(':')
      const name = parts.pop()!.trim()
      top().push({ t: 'var', name, filters: parts.map((p) => p.trim()).filter(Boolean) })
    }
  }

  const tail = tmpl.slice(last)
  if (tail) top().push({ t: 'text', v: tail })
  return root
}

export interface RenderOptions {
  deck?: string
  subdeck?: string
  tags?: string[]
  /** What the user typed, for `{{type:}}` on the back. */
  typed?: string | null
  /** 0-7, for `{{CardFlag}}`. */
  flag?: number
}

interface Ctx extends Required<RenderOptions> {
  nt: NoteType
  fields: Record<string, string>
  ord: number
  side: 'front' | 'back'
  frontSide: string
}

function value(name: string, ctx: Ctx): string {
  switch (name) {
    case 'FrontSide': return ctx.frontSide
    case 'Tags': return ctx.tags.join(' ')
    case 'Type': return ctx.nt.name
    case 'Deck': return ctx.deck
    case 'Subdeck': return ctx.subdeck
    case 'Card': return template(ctx).name
    // Anki emits `flag1`…`flag7` so a template's CSS can key off it, and
    // nothing at all when the card is unflagged.
    case 'CardFlag': return ctx.flag ? `flag${ctx.flag}` : ''
    default: return ctx.fields[name] ?? ''
  }
}

/**
 * `{{#c1}}…{{/c1}}` — true when *this* card is cloze 1.
 *
 * Shared cloze decks use it to put a hint on the back of one deletion without
 * putting it on all of them. Returns null for anything that is not a cloze
 * section, so ordinary fields fall through to the emptiness test.
 */
const CLOZE_SECTION = /^c(\d+)$/
function clozeSection(name: string, ctx: Ctx): boolean | null {
  const m = CLOZE_SECTION.exec(name)
  if (!m || ctx.nt.kind !== 'cloze') return null
  return Number(m[1]) - 1 === ctx.ord
}

/** Cloze and occlusion types have one template driving every ord. */
const template = (ctx: Ctx) =>
  ctx.nt.templates[ctx.nt.kind === 'standard' ? ctx.ord : 0] ?? { name: '', qfmt: '', afmt: '' }

/** Strip combining marks, for `{{type:nc:Field}}` — "é" grades as "e". */
export const stripCombining = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '')

function filter(name: string, v: string, field: string, ctx: Ctx): string {
  switch (name) {
    case 'text':
      return stripHtml(v)
    case 'hint':
      // `<details>` instead of Anki's onclick handler — the iframe has no JS,
      // and native disclosure is keyboard-accessible for free.
      return isEmpty(v)
        ? ''
        : `<details class="hint"><summary>${escapeHtml(field)}</summary>${v}</details>`
    case 'cloze':
      return renderCloze(v, ctx.ord, ctx.side)
    case 'occlusion':
      return occlusionHtml(v, ctx.fields.Image ?? '', ctx.ord, ctx.side)
    default:
      // furigana:/kana:/kanji: and any custom filter from an imported deck.
      // Passing the raw value through beats rendering "unknown filter" over
      // somebody's collection.
      return v
  }
}

function typedSlot(node: Extract<Node, { t: 'var' }>, ctx: Ctx): string {
  const raw = value(node.name, ctx)
  let expected = node.filters.includes('cloze') ? clozeAnswer(raw, ctx.ord) : stripHtml(raw)
  let typed = ctx.typed ?? ''
  if (node.filters.includes('nc')) {
    expected = stripCombining(expected)
    typed = stripCombining(typed)
  }
  // The input itself is a React control outside the iframe — a script-less
  // sandbox cannot host one. The slot marks where it belongs.
  return ctx.side === 'front'
    ? '<div class="type-slot"></div>'
    : typeAnswerHtml(expected, typed)
}

function emit(nodes: Node[], ctx: Ctx): string {
  let out = ''
  for (const node of nodes) {
    if (node.t === 'text') {
      out += node.v
    } else if (node.t === 'sec') {
      const cloze = clozeSection(node.name, ctx)
      const truthy = cloze ?? !isEmpty(value(node.name, ctx))
      if (truthy !== node.neg) out += emit(node.body, ctx)
    } else if (node.filters.includes('type')) {
      out += typedSlot(node, ctx)
    } else {
      let v = value(node.name, ctx)
      // Right to left: the filter nearest the field name applies first.
      for (let i = node.filters.length - 1; i >= 0; i--) v = filter(node.filters[i]!, v, node.name, ctx)
      out += v
    }
  }
  return out
}

export function renderSide(
  nt: NoteType,
  fields: Record<string, string>,
  ord: number,
  side: 'front' | 'back',
  opts: RenderOptions & { frontSide?: string } = {},
): string {
  const ctx: Ctx = {
    nt, fields, ord, side,
    deck: opts.deck ?? '',
    subdeck: opts.subdeck ?? '',
    tags: opts.tags ?? [],
    typed: opts.typed ?? null,
    flag: opts.flag ?? 0,
    frontSide: opts.frontSide ?? '',
  }
  const tmpl = template(ctx)
  return emit(parse(side === 'front' ? tmpl.qfmt : tmpl.afmt), ctx)
}

export interface RenderedCard {
  front: string
  back: string
  /** Set when the template asks the user to type — the app renders the input. */
  typeField: string | null
}

export function renderCard(
  nt: NoteType,
  fields: Record<string, string>,
  ord: number,
  opts: RenderOptions = {},
): RenderedCard {
  const front = renderSide(nt, fields, ord, 'front', opts)
  return {
    front,
    back: renderSide(nt, fields, ord, 'back', { ...opts, frontSide: front }),
    typeField: typeFieldOf(nt, ord),
  }
}

export function typeFieldOf(nt: NoteType, ord: number): string | null {
  const tmpl = nt.templates[nt.kind === 'standard' ? ord : 0]
  const m = tmpl && /\{\{type:(?:(?:cloze|nc):)*([^}]+)\}\}/.exec(tmpl.qfmt)
  return m ? m[1]!.trim() : null
}

/**
 * Which cards this note should have.
 *
 * The generation rule, implemented literally: render the front with the note's
 * fields, then render it again with every field blank. If the two agree, no
 * field content reached the output and there is no card — which is exactly how
 * `{{#Add Reverse}}` switches card 2 on and off, with no special case for it.
 */
export function generatedOrds(nt: NoteType, fields: Record<string, string>): number[] {
  if (nt.kind === 'cloze') {
    // Every field, not just the one the template clozes — Anki's own rule
    // (`cloze_numbers_in_note` iterates the whole note). A `{{c2::…}}` typed
    // into Back Extra really is a second card there, so it is one here.
    const ords = new Set(nt.fields.flatMap((f) => clozeOrds(fields[f] ?? '')))
    return [...ords].sort((a, b) => a - b)
  }
  if (nt.kind === 'occlusion') return occlusionOrds(fields[nt.ordField ?? 'Occlusion'] ?? '')

  // Empty fields are normalised to '' first, so a Front holding nothing but a
  // stray `<br>` from the editor renders identically to a blank note and makes
  // no card — Anki's behaviour, and the difference between 1 card and 0.
  const filled = Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k, isEmpty(v) ? '' : v]),
  )
  const blank = Object.fromEntries(nt.fields.map((f) => [f, '']))
  return nt.templates
    .map((_, ord) => ord)
    .filter((ord) => renderSide(nt, filled, ord, 'front') !== renderSide(nt, blank, ord, 'front'))
}
