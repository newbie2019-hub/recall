/** Tiny HTML helpers. No DOM — these run in a worker, in Node, and in RN. */

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ',
}

export const decodeEntities = (s: string) =>
  s.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/** `{{text:Field}}`. Tags out, entities decoded, `<br>` and block ends to spaces. */
export const stripHtml = (s: string) =>
  decodeEntities(s.replace(/<(br|\/p|\/div|\/li)[^>]*>/gi, ' ').replace(/<[^>]*>/g, ''))

/**
 * Anki's emptiness test, which drives both conditionals and card generation.
 *
 * It deliberately does *not* strip tags. A field holding only `<img src=…>` is
 * **not** empty — that is what lets an image-only Front make a card and an
 * image in `{{#Add Reverse}}` switch card 2 on. Only whitespace and the tags a
 * contenteditable leaves behind count as nothing, which is Anki's own rule
 * (`field_is_empty` in rslib/src/template.rs).
 */
const BLANK = /^(?:\s|<\/?(?:br|div)\s*\/?>)*$/i
export const isEmpty = (s: string | undefined) => BLANK.test(s ?? '')
