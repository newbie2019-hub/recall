import { useEffect, useRef, useState } from 'react'
import { Square, Circle, Trash2, ImagePlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { parseOcclusion, type OcclusionMode, type Shape } from '@recall/core'
import { mediaRef, mediaUrl, storeMedia } from '@/lib/media'

/**
 * Draw masks on an image; each mask becomes a card.
 *
 * Coordinates are normalised 0–1 on save, so a mask stays put if the image is
 * ever re-encoded at a different size. Shape `ord` is the card ord directly.
 *
 * ponytail: rectangles and ellipses only. The renderer and the data model
 * already do polygons — Anki exports them and Phase 3 will import them — but
 * drawing one needs click-to-place-vertices and an escape-to-finish state
 * machine, and a rectangle covers what a person actually draws over a
 * histology plate. Add it when someone asks.
 */

const IMG_SHA = /media\/([0-9a-f]{64})/

export function OcclusionEditor({
  occlusion,
  image,
  onChange,
}: {
  occlusion: string
  image: string
  onChange: (next: { occlusion: string; image: string }) => void
}) {
  const parsed = parseOcclusion(occlusion)
  const [tool, setTool] = useState<'rect' | 'ellipse'>('rect')
  const [draft, setDraft] = useState<Shape | null>(null)
  const [src, setSrc] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const start = useRef<{ x: number; y: number } | null>(null)

  const sha = IMG_SHA.exec(image)?.[1]
  useEffect(() => {
    if (!sha) return setSrc(null)
    void mediaUrl(sha).then(setSrc)
  }, [sha])

  const write = (shapes: Shape[], mode: OcclusionMode = parsed.mode) =>
    onChange({ occlusion: JSON.stringify({ mode, shapes }), image })

  async function pickImage(file: File | undefined) {
    if (!file) return
    const hash = await storeMedia(file)
    onChange({ occlusion, image: `<img src="${mediaRef(hash)}">` })
  }

  const at = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    }
  }

  const onDown = (e: React.PointerEvent) => {
    if (!src) return
    e.currentTarget.setPointerCapture(e.pointerId)
    start.current = at(e)
  }

  const onMove = (e: React.PointerEvent) => {
    if (!start.current) return
    const p = at(e)
    const s = start.current
    setDraft({
      kind: tool,
      ord: parsed.shapes.length,
      x: Math.min(s.x, p.x), y: Math.min(s.y, p.y),
      w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y),
    })
  }

  const onUp = () => {
    start.current = null
    // A click that drew nothing is a click, not a mask.
    if (draft && draft.kind !== 'polygon' && draft.w > 0.01 && draft.h > 0.01)
      write([...parsed.shapes, draft])
    setDraft(null)
  }

  const remove = (ord: number) =>
    // Ords are renumbered so they stay dense — a gap would leave an orphan card.
    write(parsed.shapes.filter((s) => s.ord !== ord).map((s, i) => ({ ...s, ord: i })))

  if (!src)
    return (
      <label className="flex cursor-pointer flex-col items-center justify-center gap-2 border border-dashed border-border py-14 text-sm text-muted-foreground hover:text-foreground">
        <ImagePlus className="size-5" />
        Choose an image to occlude
        <input type="file" accept="image/*" className="sr-only"
               onChange={(e) => void pickImage(e.target.files?.[0])} />
      </label>
    )

  const shown = draft ? [...parsed.shapes, draft] : parsed.shapes

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant={tool === 'rect' ? 'secondary' : 'ghost'}
                onClick={() => setTool('rect')}>
          <Square /> Rectangle
        </Button>
        <Button type="button" size="sm" variant={tool === 'ellipse' ? 'secondary' : 'ghost'}
                onClick={() => setTool('ellipse')}>
          <Circle /> Ellipse
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <Label htmlFor="io-mode" className="text-xs text-muted-foreground">Reveal</Label>
          <Select value={parsed.mode}
                  onValueChange={(v) => write(parsed.shapes, v as OcclusionMode)}>
            <SelectTrigger id="io-mode" size="sm" className="text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Hide all, guess one</SelectItem>
              <SelectItem value="one">Hide one, guess one</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div
        ref={box}
        className="relative inline-block max-w-full cursor-crosshair touch-none select-none"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
      >
        <img src={src} alt="" className="block max-w-full border border-border" draggable={false} />
        <svg className="absolute inset-0 size-full" viewBox="0 0 100 100" preserveAspectRatio="none">
          {shown.map((s) =>
            s.kind === 'ellipse' ? (
              <ellipse key={s.ord} cx={(s.x + s.w / 2) * 100} cy={(s.y + s.h / 2) * 100}
                       rx={(s.w / 2) * 100} ry={(s.h / 2) * 100}
                       className="fill-muted/85 stroke-eosin" style={{ strokeWidth: 0.4 }} />
            ) : s.kind === 'rect' ? (
              <rect key={s.ord} x={s.x * 100} y={s.y * 100} width={s.w * 100} height={s.h * 100}
                    className="fill-muted/85 stroke-eosin" style={{ strokeWidth: 0.4 }} />
            ) : null,
          )}
        </svg>
      </div>

      <ul className="text-sm">
        {parsed.shapes.map((s) => (
          <li key={s.ord} className="flex items-center gap-3 border-b border-border py-1.5 last:border-0">
            <span className="font-mono text-xs text-muted-foreground">Card {s.ord + 1}</span>
            <span className="flex-1 text-xs capitalize text-muted-foreground">{s.kind}</span>
            <Button type="button" size="icon-sm" variant="ghost" onClick={() => remove(s.ord)}
                    aria-label={`Delete mask ${s.ord + 1}`}>
              <Trash2 />
            </Button>
          </li>
        ))}
        {!parsed.shapes.length && (
          <li className="py-1.5 text-xs text-muted-foreground">Drag on the image to add a mask.</li>
        )}
      </ul>
    </div>
  )
}
