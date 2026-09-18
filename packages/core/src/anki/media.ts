/**
 * Rewriting an imported note's references — media filenames onto content
 * hashes, and Anki's image-occlusion syntax onto ours.
 *
 * Anki addresses media by filename inside one flat folder, which is why two
 * decks cannot be merged without collisions. We address it by the sha256 of the
 * bytes (PLAN.md §2.6), so the import maps `heart.png` → `media/<hash>` once and
 * the same diagram in twenty decks is stored once.
 */
import type { Occlusion, Shape } from '../occlusion.ts'

/** `<img src="x">`, `<audio src=x>` and Anki's `[sound:x]`. */
const SRC = /\b(src|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi
const SOUND = /\[sound:([^\]]+)\]/g

const decodeName = (raw: string) => {
  try {
    return decodeURIComponent(raw)
  } catch {
    // A stray % in a filename is legal on disk and not valid percent-encoding.
    return raw
  }
}

/** Every media filename a note's fields refer to. */
export function mediaNames(html: string): string[] {
  const names = new Set<string>()
  for (const m of html.matchAll(SRC)) {
    const raw = m[2] ?? m[3] ?? m[4] ?? ''
    // Anything already addressed — a data: URI, a remote image — is not ours.
    if (raw && !/^(https?:|data:|media\/)/i.test(raw)) names.add(decodeName(raw))
  }
  for (const m of html.matchAll(SOUND)) names.add(decodeName(m[1]!.trim()))
  return [...names]
}

/**
 * Swap every filename for what `resolve` returns. A name with no mapping is
 * left exactly as it was: a deck that shipped without its media should render
 * with a broken image where the image belongs, not with the reference deleted.
 */
export function rewriteMedia(html: string, resolve: (name: string) => string | null): string {
  return html
    .replace(SRC, (whole, attr: string, a?: string, b?: string, c?: string) => {
      const raw = a ?? b ?? c ?? ''
      if (!raw || /^(https?:|data:|media\/)/i.test(raw)) return whole
      const to = resolve(decodeName(raw))
      return to ? `${attr}="${to}"` : whole
    })
    .replace(SOUND, (whole, name: string) => {
      const to = resolve(decodeName(name.trim()))
      return to ? `[sound:${to}]` : whole
    })
}

// ── image occlusion ───────────────────────────────────────────────────────

/**
 * Anki writes occlusion shapes as cloze deletions over a mini-language:
 *
 *   {{c1::image-occlusion:rect:left=10:top=20:width=30:height=40:oi=1}}
 *   {{c2::image-occlusion:ellipse:left=50:top=60:rx=10:ry=8}}
 *   {{c3::image-occlusion:polygon:points=10,20 30,40 50,60}}
 *
 * The numbers are pixels against the image's natural size, so they cannot be
 * used until the image has been measured — `normaliseShapes` is the second half
 * of this, and the caller supplies the dimensions because measuring an image
 * needs a platform (`createImageBitmap` on the web).
 */
const OCCLUSION = /\{\{c(\d+)::image-occlusion:([a-z]+)([^}]*)\}\}/gi

const params = (rest: string): Record<string, string> =>
  Object.fromEntries(
    rest.split(':').filter(Boolean).map((p) => {
      const at = p.indexOf('=')
      return at < 0 ? [p.trim(), ''] : [p.slice(0, at).trim(), p.slice(at + 1).trim()]
    }),
  )

const n = (v: string | undefined) => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

/** Shapes in image pixels, plus whether inactive shapes stay covered. */
export interface AnkiOcclusion {
  mode: Occlusion['mode']
  shapes: Shape[]
}

export function parseAnkiOcclusion(field: string): AnkiOcclusion {
  const shapes: Shape[] = []
  let mode: Occlusion['mode'] = 'one'

  for (const m of field.matchAll(OCCLUSION)) {
    // Anki's ordinals are 1-based and ours are 0-based, the same offset the
    // cloze renderer already uses.
    const ord = Number(m[1]) - 1
    const kind = m[2]!.toLowerCase()
    const p = params(m[3] ?? '')
    if (ord < 0) continue
    // `oi=1` is "occlude inactive": every other mask stays covered too.
    if (p.oi === '1') mode = 'all'

    if (kind === 'polygon') {
      const points = (p.points ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .map((pair) => pair.split(',').map(Number) as [number, number])
        .filter((pt) => pt.length === 2 && pt.every(Number.isFinite))
      if (points.length > 2) shapes.push({ kind: 'polygon', ord, points })
    } else if (kind === 'ellipse') {
      // Anki's ellipse is a centre and two radii; ours is a bounding box, which
      // is what the SVG renderer and the editor's handles both want.
      const rx = n(p.rx)
      const ry = n(p.ry)
      shapes.push({ kind: 'ellipse', ord, x: n(p.left) - rx, y: n(p.top) - ry, w: rx * 2, h: ry * 2 })
    } else {
      shapes.push({ kind: 'rect', ord, x: n(p.left), y: n(p.top), w: n(p.width), h: n(p.height) })
    }
  }
  return { mode, shapes }
}

/**
 * Pixels → the 0–1 coordinates we store, so a mask survives the image being
 * re-encoded at another size.
 *
 * Returns null when the image could not be measured. The caller then leaves the
 * field alone, and the card renders as the bare image: a plate with no masks is
 * visibly wrong and recoverable, where masks at the wrong coordinates look
 * deliberate and are not.
 */
export function normaliseOcclusion(
  occ: AnkiOcclusion,
  width: number,
  height: number,
): string | null {
  if (!occ.shapes.length || !(width > 0) || !(height > 0)) return null
  const shapes = occ.shapes.map((s): Shape =>
    s.kind === 'polygon'
      ? { ...s, points: s.points.map(([x, y]) => [x / width, y / height] as [number, number]) }
      : { ...s, x: s.x / width, y: s.y / height, w: s.w / width, h: s.h / height },
  )
  return JSON.stringify({ mode: occ.mode, shapes })
}
