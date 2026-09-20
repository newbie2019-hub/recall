import { useCallback, useEffect, useRef, useState } from 'react'
import { MoreHorizontal, Undo2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SpecimenTag } from './SpecimenTag'
import { RatingBar } from './RatingBar'
import { CardFrame } from './CardFrame'
import { Pomodoro } from './Pomodoro'
import { AudioAutoplay } from './AudioAutoplay'
import { RATING_SFX, sfx } from '@/lib/sfx'
import * as repo from '@/db/repo'
import { stopwatch, type Stopwatch } from '@/lib/stopwatch'
import { WhyWrong } from '@/components/WhyWrong'
import { answerCard } from '@/db/queries/filtered'
import { paintCard, type PaintedCard } from '@/lib/render'
import { previewIntervals, type RatingValue } from '@recall/core'

export function Review({ deckId, onExit }: { deckId?: string | null; onExit: () => void }) {
  const [sc, setSc] = useState<repo.StudyCard | null>(null)
  const [painted, setPainted] = useState<PaintedCard | null>(null)
  const [counts, setCounts] = useState({ due: 0, new: 0, done: 0 })
  const [revealed, setRevealed] = useState(false)
  const [typed, setTyped] = useState('')
  const [loading, setLoading] = useState(true)
  // Not `Date.now() - shownAt`: that counts lunch breaks, background tabs and
  // the ten minutes a card sat on screen while somebody took a phone call.
  // `stopwatch` stops for all three, and `recordReview` caps what is left.
  const clock = useRef<Stopwatch | null>(null)
  const typeBox = useRef<HTMLInputElement>(null)

  useEffect(() => () => clock.current?.stop(), [])

  const paint = useCallback(
    (card: repo.StudyCard, answer: string) =>
      paintCard(card.noteType, card.note.fields, card.card.ord, {
        deck: card.deckPath,
        subdeck: card.deckName,
        tags: card.note.tags,
        typed: answer,
      }),
    [],
  )

  const load = useCallback(async () => {
    const [next, c] = await Promise.all([repo.nextCard(deckId), repo.counts(deckId)])
    setSc(next)
    if (!next && answered.current) sfx('complete')
    setPainted(next ? await paint(next, '') : null)
    setCounts(c)
    setRevealed(false)
    setTyped('')
    setLoading(false)
    clock.current?.stop()
    clock.current = stopwatch()
  }, [deckId, paint])

  useEffect(() => {
    void load()
  }, [load])

  // Focus the answer box as soon as a type-in card comes up — the card is asking
  // a question that can only be answered by typing.
  useEffect(() => {
    if (!revealed && painted?.typeField) typeBox.current?.focus()
  }, [revealed, painted])

  const reveal = useCallback(async () => {
    if (!sc || revealed) return
    // Before the await, not after: the sound confirms the tap, and a
    // confirmation that waits on a re-render is late enough to feel broken.
    sfx('flip')
    // Re-render the back now that there is an answer to grade against.
    if (painted?.typeField) setPainted(await paint(sc, typed))
    setRevealed(true)
  }, [sc, revealed, painted, typed, paint])

  // One answer per card. Two fast keypresses would otherwise both pass the
  // `revealed` check while the first write is still in flight and log two
  // reviews for the same card — and the log is the source of truth.
  const busy = useRef(false)

  // Whether this session has actually answered anything, so the completion
  // sound does not fire on mount for somebody who was already finished today.
  const answered = useRef(false)

  const rate = useCallback(
    async (rating: RatingValue) => {
      if (!sc || !revealed || busy.current) return
      sfx(RATING_SFX[rating])
      busy.current = true
      answered.current = true
      try {
        await answerCard(sc, rating, clock.current?.elapsed() ?? 0)
        await load()
      } finally {
        busy.current = false
      }
    },
    [sc, revealed, load],
  )

  const undo = useCallback(async () => {
    if (await repo.undoLast()) {
      sfx('undo')
      await load()
      toast('Review undone')
    } else {
      toast('Nothing to undo')
    }
  }, [load])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const typing = e.target instanceof HTMLInputElement
      if (e.key === 'Enter' && !revealed) {
        e.preventDefault()
        return void reveal()
      }
      if (typing) return // digits belong to the answer box, not to the rating bar
      if (e.key === 'u') return void undo()
      if (!revealed && e.key === ' ') {
        e.preventDefault()
        return void reveal()
      }
      if (revealed && e.key >= '1' && e.key <= '4') void rate(Number(e.key) as RatingValue)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [revealed, rate, undo, reveal])

  if (loading) return <div className="p-10 text-sm text-muted-foreground">Opening collection…</div>

  if (!sc || !painted) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
        <p className="font-display text-3xl">Nothing due</p>
        <p className="text-sm text-muted-foreground">
          {counts.done > 0
            ? `${counts.done} reviewed today. Come back when the next batch is ready.`
            : 'Add a deck to start studying.'}
        </p>
        <Button variant="outline" onClick={onExit}>
          Back to decks
        </Button>
      </div>
    )
  }

  const remaining = counts.due + counts.new
  const total = remaining + counts.done
  const now = Date.now()
  const intervals = previewIntervals(sc.card, now, sc.retentionTarget)

  return (
    <div className="mx-auto flex min-h-dvh max-w-2xl flex-col px-4 py-4 sm:px-6">
      {/* Everything that is not the card is a distraction. Keep this thin. */}
      <header className="flex items-center gap-3">
        <Progress value={total ? (counts.done / total) * 100 : 0} className="h-1 flex-1" />
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {counts.done}/{total}
        </span>
        <AudioAutoplay html={revealed ? painted.back : painted.front} deckId={deckId ?? null} />
        <Pomodoro deckId={deckId ?? null} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Card actions">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => repo.bury(sc.card.id).then(load)}>
              Bury until tomorrow
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => repo.suspend(sc.card.id).then(load)}>
              Suspend
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => repo.setFlag(sc.card.id, sc.card.flag ? 0 : 1).then(load)}>
              {sc.card.flag ? 'Clear flag' : 'Flag'}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={undo}>
              <Undo2 /> Undo last review
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onExit}>Back to decks</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <main className="flex flex-1 items-center py-6">
        <SpecimenTag
          catalog={sc.note.fma_id ?? sc.card.id.slice(0, 8).toUpperCase()}
          path={sc.deckPath}
          className="w-full"
        >
          {/* Both sides stay mounted and stacked in one grid cell. That buys the
              120ms cross-dissolve without tearing down the frame, and it sizes
              the card to the taller side — so revealing never jumps the layout. */}
          <div className="grid w-full">
            <div
              className="col-start-1 row-start-1 transition-opacity duration-[120ms] ease-out"
              style={{ opacity: revealed ? 0 : 1 }}
              aria-hidden={revealed}
              inert={revealed}
            >
              <CardFrame html={painted.front} css={sc.noteType.css} />
              {painted.typeField && (
                <Input
                  ref={typeBox}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder="Type your answer"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  className="mt-5 font-mono"
                  aria-label={`Type the ${painted.typeField} field`}
                />
              )}
            </div>
            <div
              className="col-start-1 row-start-1 transition-[opacity,transform] duration-[120ms] ease-out"
              style={{ opacity: revealed ? 1 : 0, transform: revealed ? 'none' : 'translateY(2px)' }}
              aria-hidden={!revealed}
              inert={!revealed}
            >
              <CardFrame html={painted.back} css={sc.noteType.css} />
              {/* Keyed on the card, so the answer for one card never survives
                  onto the next. Below the frame and outside it: this is app
                  text, not card content, and card content gets an iframe
                  because it is untrusted (README rule 5). */}
              {revealed && <WhyWrong key={sc.card.id} card={sc} />}
            </div>
          </div>
        </SpecimenTag>
      </main>

      <footer className="pb-[env(safe-area-inset-bottom)]">
        {revealed ? (
          <RatingBar intervals={intervals} now={now} onRate={rate} />
        ) : (
          <Button size="lg" className="h-12 w-full" onClick={reveal}>
            Show answer
            <span className="font-mono text-[0.625rem] opacity-60">
              {painted.typeField ? 'enter' : 'space'}
            </span>
          </Button>
        )}
      </footer>
    </div>
  )
}
