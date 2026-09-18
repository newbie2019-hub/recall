import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { Coffee, Square, Timer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { collectionReady } from '@/db/boot'
import { focusBlocks, type FocusBlock } from '@/db/queries/pomodoro'
import { formatClock, usePomodoro } from '@/hooks/usePomodoro'
import { paths } from './paths'

/**
 * The focus timer's own screen — the same hook the study-header widget uses,
 * given room, plus the thing the table was added for: what the last few focus
 * blocks did to accuracy.
 *
 * Blocks with no reviews in them are still listed. "I sat down for 25 minutes
 * and answered four cards" is the most useful row on this page.
 */

const startOfToday = () => new Date(new Date().setHours(0, 0, 0, 0)).getTime()
const WEEK_MS = 7 * 24 * 60 * 60_000

const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

export function PomodoroPage() {
  const navigate = useNavigate()
  const { session, remaining, progress, finished, start, stop, dismiss } = usePomodoro()
  const [blocks, setBlocks] = useState<FocusBlock[] | null>(null)

  const reload = useCallback(async () => {
    await collectionReady
    setBlocks(await focusBlocks(Date.now() - WEEK_MS))
  }, [])

  // Reload whenever a block starts or ends — `session` changing is exactly that.
  useEffect(() => void reload(), [reload, session])

  const today = startOfToday()
  const todays = blocks?.filter((b) => b.started_at >= today) ?? []
  const reviewed = todays.reduce((s, b) => s + b.reviews, 0)

  return (
    <div className="mx-auto min-h-dvh max-w-2xl px-4 py-10 sm:px-6">
      <header className="mb-10">
        <h1 className="font-display text-5xl tracking-tight">Focus</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Twenty-five minutes, then five. {todays.length
            ? `${todays.length} block${todays.length === 1 ? '' : 's'} today, ${reviewed} cards in them.`
            : 'Nothing logged today.'}
        </p>
      </header>

      <section className="mb-12 flex flex-col items-center gap-5 border-y border-border py-12">
        <span
          className="font-mono text-7xl tabular-nums"
          // The whole clock re-reads on every repaint, which a screen reader
          // would announce once a second. It is decorative; the button is not.
          aria-hidden
        >
          {session ? formatClock(remaining) : '25:00'}
        </span>

        {session && (
          <span className="h-1 w-56 overflow-hidden rounded-full bg-border" aria-hidden>
            <span
              className="block h-full bg-hematoxylin"
              style={{ width: `${progress * 100}%` }}
            />
          </span>
        )}

        {session ? (
          <Button variant="outline" onClick={stop}>
            <Square /> Stop {session.kind === 'break' ? 'break' : 'focus block'}
          </Button>
        ) : finished ? (
          <div className="flex gap-2">
            <Button onClick={() => void start(finished === 'focus' ? 'break' : 'focus')}>
              {finished === 'focus' ? <Coffee /> : <Timer />}
              {finished === 'focus' ? 'Take five' : 'Back to work'}
            </Button>
            <Button variant="ghost" onClick={dismiss}>
              Not now
            </Button>
          </div>
        ) : (
          <div className="flex gap-2">
            <Button onClick={() => void start('focus')}>
              <Timer /> Start focus
            </Button>
            <Button variant="outline" onClick={() => navigate(paths.study())}>
              Study
            </Button>
          </div>
        )}
      </section>

      <h2 className="mb-2 font-display text-xl">Last seven days</h2>
      {blocks?.length ? (
        <ul>
          {blocks.map((b) => (
            <li
              key={b.id}
              className="flex items-baseline gap-3 border-b border-border py-2.5 text-sm last:border-0"
            >
              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                {time.format(b.started_at)}
              </span>
              <span className="flex-1">
                {Math.round((Math.min(b.ended_at ?? Date.now(), b.started_at + b.planned_ms) - b.started_at) / 60_000)} min
              </span>
              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                {b.reviews} cards
              </span>
              <span className="w-12 text-right font-mono text-xs tabular-nums text-hematoxylin">
                {/* No percentage on a handful of cards — three-for-three is not
                    100% accuracy, it is three cards. */}
                {b.reviews >= 5 ? `${Math.round((b.correct / b.reviews) * 100)}%` : '—'}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          {blocks ? 'No focus blocks yet.' : 'Opening collection…'}
        </p>
      )}
    </div>
  )
}
