import { stripHtml, escapeHtml } from './html.ts'

/**
 * Character diff for `{{type:Field}}`.
 *
 * Anki shows what you typed with the wrong characters marked, and underneath the
 * expected answer with the ones you missed. That needs a real alignment, not a
 * position-by-position compare — a single dropped letter must not paint the rest
 * of the word red.
 *
 * ponytail: plain LCS, O(n·m) time and space. Capped at CAP characters because a
 * type-in answer is a word or a sentence; anything longer is a field someone
 * mis-templated, and it falls back to a whole-string compare rather than
 * allocating a 4 MB table.
 */
const CAP = 300

type Op = 'eq' | 'del' | 'ins'

function align(a: string[], b: string[]): [Op, string][] {
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)

  const ops: [Op, string][] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) ops.push(['eq', a[i]!]), i++, j++
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) ops.push(['del', a[i]!]), i++
    else ops.push(['ins', b[j]!]), j++
  }
  while (i < n) ops.push(['del', a[i++]!])
  while (j < m) ops.push(['ins', b[j++]!])
  return ops
}

/** Normalised comparison text. Case- and accent-sensitive, like Anki. */
export const typeNormalise = (s: string) => stripHtml(s).replace(/\s+/g, ' ').trim()

export function typeAnswerHtml(expected: string, typed: string): string {
  const want = typeNormalise(expected)
  const got = typeNormalise(typed)

  if (want === got)
    return `<div class="typed typed-ok">${escapeHtml(got) || '&nbsp;'}</div>`

  if (want.length > CAP || got.length > CAP)
    return (
      `<div class="typed"><span class="typed-bad">${escapeHtml(got) || '&nbsp;'}</span></div>` +
      `<div class="typed-expected">${escapeHtml(want)}</div>`
    )

  const ops = align([...want], [...got])
  const run = (keep: Op[], cls: Partial<Record<Op, string>>) => {
    let out = ''
    let open: string | null = null
    for (const [op, ch] of ops) {
      if (!keep.includes(op)) continue
      const c = cls[op] ?? null
      if (c !== open) {
        if (open) out += '</span>'
        if (c) out += `<span class="${c}">`
        open = c
      }
      out += escapeHtml(ch)
    }
    return open ? out + '</span>' : out
  }

  return (
    `<div class="typed">${run(['eq', 'ins'], { ins: 'typed-bad' }) || '&nbsp;'}</div>` +
    `<div class="typed-expected">${run(['eq', 'del'], { del: 'typed-missing' })}</div>`
  )
}
