/**
 * Anki cloze deletions: `{{c1::answer}}`, `{{c1::answer::hint}}`, nested.
 *
 * A recursive parser rather than a regex, because nesting is the whole point:
 * `{{c1::the {{c2::mitral}} valve}}` must blank the entire c1 span when c1 is
 * being asked, and blank only the inner span when c2 is. No depth limit — the
 * manual promises three, the parser doesn't care.
 *
 * Everything public here speaks **card ords** (0-based, Anki's storage
 * convention), not the 1-based numbers written in the text. The one conversion
 * lives in `matches()` below so no caller has to remember it.
 */

type Node = { text: string } | { n: number; hint: string | null; body: Node[] }

const OPEN = /^\{\{c(\d+)::/

const matches = (n: number, ord: number) => n - 1 === ord

export function parseCloze(src: string): Node[] {
  let i = 0

  function body(inside: boolean): { nodes: Node[]; hint: string | null } {
    const nodes: Node[] = []
    let buf = ''
    let hint: string | null = null
    const flush = () => {
      if (buf) nodes.push({ text: buf })
      buf = ''
    }

    while (i < src.length) {
      const rest = src.slice(i)
      const open = OPEN.exec(rest)
      if (open) {
        flush()
        i += open[0].length
        const inner = body(true)
        nodes.push({ n: Number(open[1]), hint: inner.hint, body: inner.nodes })
        continue
      }
      if (inside && rest.startsWith('}}')) {
        i += 2
        break
      }
      // A top-level `::` inside a cloze starts the hint, which runs to the close.
      // Anki does not allow nesting inside a hint, and neither does this.
      if (inside && rest.startsWith('::')) {
        i += 2
        const end = src.indexOf('}}', i)
        const stop = end === -1 ? src.length : end
        hint = src.slice(i, stop)
        i = stop === src.length ? stop : stop + 2
        break
      }
      buf += src[i++]
    }

    flush()
    return { nodes, hint }
  }

  return body(false).nodes
}

/**
 * Card ords this text generates, ascending and deduplicated.
 *
 * Sparse is correct: `{{c1::}}` and `{{c3::}}` with no c2 give ords 0 and 2,
 * exactly as Anki does — renumbering them would move somebody's review history
 * onto the wrong card. `c0` is not legal in Anki and is dropped rather than
 * turned into ord -1, which would be a card id nothing could ever find again.
 */
export function clozeOrds(src: string): number[] {
  const found = new Set<number>()
  const walk = (nodes: Node[]) => {
    for (const node of nodes) {
      if ('text' in node) continue
      if (node.n >= 1) found.add(node.n - 1)
      walk(node.body)
    }
  }
  walk(parseCloze(src))
  return [...found].sort((a, b) => a - b)
}

export function renderCloze(src: string, ord: number, side: 'front' | 'back'): string {
  const walk = (nodes: Node[]): string =>
    nodes
      .map((node) => {
        if ('text' in node) return node.text
        const inner = walk(node.body)
        if (!matches(node.n, ord)) return inner
        return side === 'front'
          ? `<span class="cloze-blank">[${node.hint || '...'}]</span>`
          : `<span class="cloze">${inner}</span>`
      })
      .join('')
  return walk(parseCloze(src))
}

/** The text with every deletion unwrapped — for list previews and search. */
export const clozeText = (src: string): string => plain(parseCloze(src))

/** The active deletion's text, unwrapped — what `{{type:cloze:Text}}` grades against. */
export function clozeAnswer(src: string, ord: number): string {
  const walk = (nodes: Node[]): string => {
    for (const node of nodes) {
      if ('text' in node) continue
      if (matches(node.n, ord)) return plain(node.body)
      const deeper = walk(node.body)
      if (deeper) return deeper
    }
    return ''
  }
  return walk(parseCloze(src))
}

const plain = (nodes: Node[]): string =>
  nodes.map((n) => ('text' in n ? n.text : plain(n.body))).join('')
