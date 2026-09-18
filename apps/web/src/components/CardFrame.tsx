import { useEffect, useRef, useState } from 'react'
import katexCss from 'katex/dist/katex.min.css?inline'
import literataCss from '@fontsource-variable/literata/index.css?inline'
import monoCss from '@fontsource/ibm-plex-mono/400.css?inline'
import { cn } from '@/lib/utils'

/**
 * Card content renders in a sandboxed iframe, and the sandbox is exactly
 * `allow-same-origin` — no `allow-scripts`.
 *
 * Imported Anki decks bring their own HTML and CSS and are untrusted (PLAN.md
 * §3.5). Without `allow-scripts` nothing in that markup can execute, which is
 * the whole point. `allow-same-origin` is then safe *because* scripts are off:
 * it buys blob: media (opaque origins cannot read the parent's blob URLs) and
 * lets us measure the content to size the frame. The two flags together would
 * be an escape hatch; either one alone is not.
 *
 * CSS can still exfiltrate by loading a remote font or background image, so the
 * meta CSP pins every source to this origin, blob: and data:.
 *
 * Consequences that shape everything else: KaTeX runs in the parent and ships
 * static HTML (lib/render.ts), `{{hint:}}` compiles to `<details>` rather than a
 * click handler, image occlusion is SVG rather than canvas, and the type-in
 * input is a React control outside the frame.
 */

const CSP =
  "default-src 'none'; img-src 'self' blob: data:; media-src 'self' blob: data:; " +
  "style-src 'unsafe-inline'; font-src 'self' data:"

/** Palette pulled from the host so the card follows the app's theme exactly. */
const PALETTE = [
  '--card', '--card-foreground', '--muted-foreground', '--rule',
  '--hematoxylin', '--eosin', '--paper',
]

const BASE_CSS = `
  html { color-scheme: light dark; }
  body {
    margin: 0; background: transparent; color: var(--card-foreground);
    font-family: 'Literata Variable', Georgia, serif;
    font-size: 1.125rem; line-height: 1.65; overflow-wrap: break-word;
  }
  p { margin: 0 0 0.75em; } p:last-child { margin-bottom: 0; }
  img { max-width: 100%; height: auto; display: block; border: 1px solid var(--rule); }
  audio { width: 100%; margin: 0.5rem 0; }

  /* The specimen tag's double rule, reused as the question/answer divider. */
  hr#answer {
    border: 0; height: 1px; background: var(--rule); margin: 1.4rem 0;
    box-shadow: 0 3px 0 -2px var(--rule);
  }

  .cloze {
    color: var(--hematoxylin); font-weight: 600;
    box-shadow: inset 0 -0.35em 0 color-mix(in oklab, var(--hematoxylin) 14%, transparent);
  }
  .cloze-blank {
    font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 0.9em;
    color: var(--muted-foreground); border-bottom: 1px dashed currentColor;
    padding: 0 0.15em;
  }

  .hint { display: inline; }
  .hint > summary {
    display: inline; cursor: pointer; font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 0.7rem; letter-spacing: 0.16em; text-transform: uppercase;
    color: var(--muted-foreground);
  }
  .hint[open] > summary { color: var(--hematoxylin); }

  .typed { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 1rem; }
  .typed-ok { color: var(--hematoxylin); }
  .typed-bad { color: var(--eosin); text-decoration: line-through; }
  .typed-missing { color: var(--eosin); border-bottom: 2px solid currentColor; }
  .typed-expected {
    font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 1rem;
    color: var(--muted-foreground); margin-top: 0.25rem;
  }

  /* Image occlusion: masks are label stickers over a plate, not black boxes. */
  .io { position: relative; display: inline-block; max-width: 100%; }
  .io-overlay { position: absolute; inset: 0; width: 100%; height: 100%; }
  .io-mask { fill: var(--paper); stroke: var(--rule); stroke-width: 0.3; vector-effect: non-scaling-stroke; }
  .io-asked {
    fill: color-mix(in oklab, var(--eosin) 25%, var(--paper));
    stroke: var(--eosin); stroke-width: 0.6; stroke-dasharray: 2 1.5;
    vector-effect: non-scaling-stroke;
  }
  .io-revealed { fill: none; stroke: var(--eosin); stroke-width: 0.8; vector-effect: non-scaling-stroke; }
  .io-header, .extra {
    font-family: ui-sans-serif, system-ui, sans-serif; font-size: 0.875rem;
    color: var(--muted-foreground);
  }
  .io-header { margin-bottom: 0.75rem; letter-spacing: 0.02em; }
  .extra { margin-top: 1rem; }

  .type-slot { display: none; }
  .math-error { color: var(--eosin); font-size: 0.875rem; }
  .katex-display { margin: 0.75em 0; overflow-x: auto; overflow-y: hidden; }
`

function document_(html: string, css: string, palette: string) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<style>${literataCss}${monoCss}${katexCss}</style>
<style>:root{${palette}}${BASE_CSS}</style>
<style>${css}</style>
</head><body>${html}</body></html>`
}

export function CardFrame({
  html,
  css = '',
  className,
}: {
  html: string
  css?: string
  className?: string
}) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(0)

  useEffect(() => {
    const frame = ref.current
    if (!frame) return
    const host = getComputedStyle(document.documentElement)
    const palette = PALETTE.map((v) => `${v}:${host.getPropertyValue(v)}`).join(';')
    frame.srcdoc = document_(html, css, palette)

    let observer: ResizeObserver | null = null
    const onLoad = () => {
      // Measure the body, not documentElement: the latter never reports less
      // than the viewport, so a frame sized from it could only ever grow.
      const body = frame.contentDocument?.body
      if (!body) return
      const measure = () => setHeight(body.scrollHeight)
      measure()
      observer = new ResizeObserver(measure)
      observer.observe(body)
    }
    frame.addEventListener('load', onLoad)
    return () => {
      frame.removeEventListener('load', onLoad)
      observer?.disconnect()
    }
  }, [html, css])

  return (
    <iframe
      ref={ref}
      title="Card"
      sandbox="allow-same-origin"
      scrolling="no"
      className={cn('w-full border-0', className)}
      style={{ height: height || undefined }}
    />
  )
}
