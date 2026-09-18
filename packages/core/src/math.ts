import { decodeEntities } from './html.ts'

/**
 * Anki's four LaTeX delimiter styles, mapped onto one renderer.
 *
 * Core stays renderer-agnostic: it finds the maths and hands each span to a
 * callback. The web app passes KaTeX's `renderToString`; React Native can pass
 * the same thing. Core never imports KaTeX, so nothing here pulls CSS or fonts
 * into a worker.
 */
const DELIMITERS: [RegExp, boolean][] = [
  [/\\\[([\s\S]+?)\\\]/g, true],
  [/\\\(([\s\S]+?)\\\)/g, false],
  [/\[\$\$\]([\s\S]+?)\[\/\$\$\]/g, true],
  [/\[\$\]([\s\S]+?)\[\/\$\]/g, false],
  [/\[latex\]([\s\S]+?)\[\/latex\]/gi, true],
]

export type MathRenderer = (tex: string, display: boolean) => string

export function renderMath(html: string, render: MathRenderer): string {
  // Split on tags so delimiters inside an attribute value are never touched.
  return html
    .split(/(<[^>]*>)/)
    .map((chunk) => {
      if (chunk.startsWith('<')) return chunk
      let out = chunk
      for (const [re, display] of DELIMITERS)
        out = out.replace(re, (_, tex: string) => render(decodeEntities(tex), display))
      return out
    })
    .join('')
}

export const hasMath = (html: string) => DELIMITERS.some(([re]) => (re.lastIndex = 0, re.test(html)))
