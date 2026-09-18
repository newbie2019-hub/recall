import { hasMath, renderCard, renderMath, type NoteType, type RenderOptions } from '@recall/core'
import { mediaUrl } from './media'

/**
 * Core renders the card; this turns its output into something a browser can
 * paint. Three passes, in this order:
 *
 *   1. template  — core, pure, tested against fixtures
 *   2. maths     — KaTeX to static HTML *here*, in the parent, because the card
 *                  frame runs no JavaScript at all (see CardFrame.tsx)
 *   3. media     — `media/<sha>` and `[sound:…]` to live blob: URLs
 *
 * ponytail: KaTeX only. The plan listed a lazy MathJax fallback; a CDN fallback
 * contradicts offline-first, and bundling MathJax costs ~1 MB to cover the
 * handful of macros KaTeX lacks. Revisit when a real imported deck fails —
 * KaTeX renders its errors inline, so we will see it.
 */

// KaTeX is a quarter of the bundle and most cards have no maths on them, so it
// loads on first sight of a delimiter. `hasMath` is the cheap check that decides.
let katex: typeof import('katex').default | null = null
const loadKatex = async () => (katex ??= (await import('katex')).default)

const tex = (src: string, display: boolean) => {
  try {
    return katex!.renderToString(src, { displayMode: display, throwOnError: false })
  } catch {
    return `<code class="math-error">${src}</code>`
  }
}

const SOUND = /\[sound:([^\]]+)\]/g
const MEDIA = /media\/([0-9a-f]{64})/g

// The filename comes out of untrusted card HTML and lands in an attribute, so
// it is escaped even though the frame runs no scripts — a stray quote there
// would otherwise let imported markup write attributes we did not put there.
const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

async function paintMedia(html: string): Promise<string> {
  const withAudio = html.replace(
    SOUND,
    (_, src: string) => `<audio controls preload="none" src="${attr(src)}"></audio>`,
  )

  const shas = [...new Set([...withAudio.matchAll(MEDIA)].map((m) => m[1]!))]
  if (!shas.length) return withAudio

  const resolved = new Map(
    await Promise.all(shas.map(async (sha) => [sha, await mediaUrl(sha)] as const)),
  )
  // A missing hash keeps its `media/<sha>` text rather than becoming a broken
  // image: the note is fine, the bytes just have not synced to this device yet.
  return withAudio.replace(MEDIA, (whole, sha) => resolved.get(sha) ?? whole)
}

export interface PaintedCard {
  front: string
  back: string
  typeField: string | null
}

export async function paintCard(
  nt: NoteType,
  fields: Record<string, string>,
  ord: number,
  opts: RenderOptions = {},
): Promise<PaintedCard> {
  const card = renderCard(nt, fields, ord, opts)
  if (hasMath(card.front) || hasMath(card.back)) await loadKatex()
  const paint = (html: string) => paintMedia(katex ? renderMath(html, tex) : html)
  const [front, back] = await Promise.all([paint(card.front), paint(card.back)])
  return { front, back, typeField: card.typeField }
}
