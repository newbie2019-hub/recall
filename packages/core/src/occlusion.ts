/**
 * Image occlusion: masks over an image, one card per mask.
 *
 * Shapes are stored as JSON in the note's `Occlusion` field with **normalised
 * 0–1 coordinates**, so a mask survives the image being re-encoded at another
 * size. Rendered as an SVG overlay rather than a canvas because the card is
 * painted inside a script-less sandboxed iframe (PLAN.md §3.5) — there is no JS
 * in there to drive a canvas, and an SVG needs none.
 *
 * Anki's own `.apkg` format writes these as `rect:left=.1:top=.2:…` strings;
 * Phase 3's importer maps that onto this shape, not the other way round.
 */
import { escapeHtml } from './html.ts'

export type Shape =
  | { kind: 'rect'; ord: number; x: number; y: number; w: number; h: number }
  | { kind: 'ellipse'; ord: number; x: number; y: number; w: number; h: number }
  | { kind: 'polygon'; ord: number; points: [number, number][] }

/** "Hide all, guess one" masks every shape; "hide one" masks only the asked one. */
export type OcclusionMode = 'all' | 'one'

export interface Occlusion {
  mode: OcclusionMode
  shapes: Shape[]
}

const EMPTY: Occlusion = { mode: 'all', shapes: [] }

/**
 * Tolerant: accepts a bare shape array or a `{ mode, shapes }` object.
 *
 * Shapes are validated, not trusted. This field is hand-editable and Phase 3
 * will fill it from an `.apkg`; one shape with a missing `ord` would otherwise
 * become a NaN ordinal, and a NaN ordinal is a card that can never be found
 * again in the review log.
 */
const KINDS = new Set(['rect', 'ellipse', 'polygon'])
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

const valid = (s: unknown): s is Shape => {
  if (typeof s !== 'object' || s === null) return false
  const r = s as Record<string, unknown>
  if (!KINDS.has(r.kind as string) || !num(r.ord) || r.ord < 0) return false
  return r.kind === 'polygon'
    ? Array.isArray(r.points) && r.points.length > 2 &&
        r.points.every((p) => Array.isArray(p) && p.length === 2 && p.every(num))
    : num(r.x) && num(r.y) && num(r.w) && num(r.h)
}

export function parseOcclusion(field: string): Occlusion {
  if (!field?.trim()) return EMPTY
  try {
    const raw = JSON.parse(field)
    const list: unknown[] = Array.isArray(raw) ? raw : (raw?.shapes ?? [])
    return {
      mode: !Array.isArray(raw) && raw?.mode === 'one' ? 'one' : 'all',
      shapes: list.filter(valid),
    }
  } catch {
    return EMPTY
  }
}

export const occlusionOrds = (field: string): number[] =>
  [...new Set(parseOcclusion(field).shapes.map((s) => s.ord))].sort((a, b) => a - b)

const pct = (v: number) => (v * 100).toFixed(3).replace(/\.?0+$/, '')

function shapeSvg(s: Shape, cls: string): string {
  if (s.kind === 'polygon')
    return `<polygon class="${cls}" points="${s.points.map(([x, y]) => `${pct(x)},${pct(y)}`).join(' ')}"/>`
  if (s.kind === 'ellipse')
    return `<ellipse class="${cls}" cx="${pct(s.x + s.w / 2)}" cy="${pct(s.y + s.h / 2)}" rx="${pct(s.w / 2)}" ry="${pct(s.h / 2)}"/>`
  return `<rect class="${cls}" x="${pct(s.x)}" y="${pct(s.y)}" width="${pct(s.w)}" height="${pct(s.h)}"/>`
}

/**
 * The overlay for one card. Classes carry the meaning; the card stylesheet
 * decides what "masked" and "asked" look like.
 */
export function occlusionSvg(occ: Occlusion, ord: number, side: 'front' | 'back'): string {
  const parts = occ.shapes
    .filter((s) => occ.mode === 'all' || s.ord === ord)
    .map((s) => {
      if (s.ord !== ord) return shapeSvg(s, 'io-mask')
      return shapeSvg(s, side === 'front' ? 'io-asked' : 'io-revealed')
    })
  return `<svg class="io-overlay" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${parts.join('')}</svg>`
}

/** `{{occlusion:Occlusion}}` — the image with its overlay on top. */
export function occlusionHtml(field: string, image: string, ord: number, side: 'front' | 'back'): string {
  const occ = parseOcclusion(field)
  if (!occ.shapes.length) return image
  const label = side === 'front' ? 'Hidden region to identify' : 'Revealed region'
  return `<div class="io" role="img" aria-label="${escapeHtml(label)}">${image}${occlusionSvg(occ, ord, side)}</div>`
}
