import { useCallback, useEffect, useState } from 'react'
import { MessageCircle, MessageCircleOff, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * `{{tts}}` spoken by the browser, from outside the frame.
 *
 * The same shape as `AudioAutoplay` and for the same reason: card HTML renders
 * in a sandbox with no `allow-scripts` (CardFrame.tsx), so nothing inside it
 * can call `speechSynthesis`. `template.ts` emits `<span class="tts" data-tts>`
 * and this reads it back out.
 *
 * `speechSynthesis` rather than a cloud voice, which is what the popular Anki
 * add-ons are for: it needs no key, no network and no per-character bill, and
 * it is the difference between shipping TTS and planning it. A deck that wants
 * a specific voice still has `[sound:]`, which travels as real audio.
 *
 * Off per deck by default, like autoplay — a phrase read aloud is delightful in
 * a language deck and hostile in a library.
 */

// Our own markup, one attribute, written by `ttsHtml` three functions ago —
// the same argument as the audio regex beside it. Non-greedy and anchored on
// the attribute, so a field containing `data-tts` as text cannot widen it.
const TTS = /<span class="tts"[^>]*\bdata-tts="([^"]*)"(?:[^>]*\bdata-tts-lang="([^"]*)")?/i

const key = (deckId: string | null) => `recall.tts.${deckId ?? 'all'}`

const stored = (deckId: string | null) => {
  try {
    return localStorage.getItem(key(deckId)) === '1'
  } catch {
    return false
  }
}

/** `&amp;` and friends, since the text went through `escapeHtml` on the way in. */
function unescape(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

export function TtsSpeaker({
  html, deckId = null, className,
}: {
  html: string
  deckId?: string | null
  className?: string
}) {
  const [on, setOn] = useState(() => stored(deckId))
  useEffect(() => setOn(stored(deckId)), [deckId])

  const match = TTS.exec(html)
  const text = match ? unescape(match[1] ?? '') : null
  const lang = match?.[2]

  const speak = useCallback(() => {
    if (!text || typeof speechSynthesis === 'undefined') return
    // Cancel first: two cards in quick succession would otherwise queue, and
    // the previous card's answer would be read over the current question.
    speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    if (lang) utterance.lang = lang
    speechSynthesis.speak(utterance)
  }, [text, lang])

  useEffect(() => {
    if (on && text) speak()
    // Silence on the way out, so leaving the reviewer mid-sentence stops it.
    return () => { if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel() }
  }, [on, text, speak])

  // No marker on this card, or a browser with no voices at all: render nothing
  // rather than a control that cannot do anything.
  if (!text || typeof speechSynthesis === 'undefined') return null

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
      <Button
        variant="ghost" size="icon-xs" onClick={toggle} aria-pressed={on}
        title={on ? 'Read aloud: on for this deck' : 'Read aloud: off for this deck'}
        aria-label="Read cards aloud in this deck"
      >
        {on ? <MessageCircle /> : <MessageCircleOff />}
      </Button>
      {!on && (
        <Button variant="ghost" size="icon-xs" onClick={speak} aria-label="Read this card aloud">
          <Play />
        </Button>
      )}
    </div>
  )
}
