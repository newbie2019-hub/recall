import { useCallback, useEffect, useRef, useState } from 'react'
import { Play, Volume2, VolumeX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * The card's `[sound:]` media, played by the parent.
 *
 * Card HTML renders in a sandbox with no `allow-scripts` (CardFrame.tsx), so
 * nothing inside the frame can start playback — exactly the constraint that put
 * the type-in box outside the frame, and this is the same shape: the element
 * lives out here and the frame keeps its inert `<audio controls>` for manual
 * replay. The blob: URL is already in the painted HTML, because `render.ts`
 * resolved `media/<sha>` before the frame ever saw it.
 *
 * Off per deck by default. Autoplay is the kind of setting that is delightful
 * for a language deck and hostile in a quiet library.
 */

// The painted HTML is ours, one element per `[sound:]`, written by
// `paintMedia` — a regex is the right size of tool for reading back a string we
// generated three functions ago, and parsing it into a DOM would create a
// document that fetches the media a second time.
const AUDIO_SRC = /<audio[^>]+\bsrc="([^"]*)"/i

const key = (deckId: string | null) => `recall.audio-autoplay.${deckId ?? 'all'}`

const stored = (deckId: string | null) => {
  try {
    return localStorage.getItem(key(deckId)) === '1'
  } catch {
    return false
  }
}

export function AudioAutoplay({
  html,
  deckId = null,
  className,
}: {
  html: string
  deckId?: string | null
  className?: string
}) {
  const el = useRef<HTMLAudioElement>(null)
  const [on, setOn] = useState(() => stored(deckId))
  // Autoplay is refused until the document has been interacted with. In a study
  // session the rating buttons supply that within one card, so the only case
  // this catches is the very first card of a fresh tab — and it says so out
  // loud rather than leaving the user wondering why the deck went quiet.
  const [blocked, setBlocked] = useState(false)

  useEffect(() => setOn(stored(deckId)), [deckId])

  const src = AUDIO_SRC.exec(html)?.[1] ?? null

  const playNow = useCallback(() => {
    const node = el.current
    if (!node) return
    node.currentTime = 0
    node.play().then(
      () => setBlocked(false),
      () => setBlocked(true),
    )
  }, [])

  useEffect(() => {
    setBlocked(false)
    if (on && src) playNow()
  }, [on, src, playNow])

  if (!src) return null

  const toggle = () => {
    const next = !on
    setOn(next)
    try {
      localStorage.setItem(key(deckId), next ? '1' : '0')
    } catch {
      // Not persisting is survivable; refusing the toggle is not.
    }
  }

  return (
    <div className={cn('flex items-center gap-1', className)}>
      <audio ref={el} src={src} preload="auto" />
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={toggle}
        aria-pressed={on}
        title={on ? 'Autoplay audio: on for this deck' : 'Autoplay audio: off for this deck'}
        aria-label="Autoplay audio for this deck"
      >
        {on ? <Volume2 /> : <VolumeX />}
      </Button>
      {blocked && (
        <Button variant="outline" size="xs" onClick={playNow}>
          <Play /> Play
        </Button>
      )}
    </div>
  )
}
