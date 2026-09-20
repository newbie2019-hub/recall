import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { Timer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useFocus } from '@/components/FocusTimer'
import { collectionReady } from '@/db/boot'
import { focusBlocks, type FocusBlock } from '@/db/queries/pomodoro'
import { formatClock, usePomodoro } from '@/hooks/usePomodoro'
import { paths } from './paths'

/**
 * What the last few focus blocks actually did to accuracy.
 *
 * The timer itself is a dialog and a bar (`components/FocusTimer.tsx`) — a
 * block exists so you can go and study, and controls that live only on their
 * own screen mean watching a clock instead of working. This page is the
 * record, which is the part that needs room.
 *
 * Blocks with no reviews in them are still listed. "I sat down for 25 minutes
 * and answered four cards" is the most useful row on this page.
 */

const startOfToday = () => new Date(new Date().setHours(0, 0, 0, 0)).getTime()
const WEEK_MS = 7 * 24 * 60 * 60_000

const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

export function PomodoroPage() {
  const navigate = useNavigate()
  const { session, remaining, progress } = usePomodoro()
  const focus = useFocus()
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
    <div className="mx-auto max-w-2xl">
      <header className="mb-10">
        <h1 className="font-display text-5xl tracking-tight">Focus</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Twenty-five minutes, then five. {todays.length
            ? `${todays.length} block${todays.length === 1 ? '' : 's'} today, ${reviewed} cards in them.`
            : 'Nothing logged today.'}
        </p>
      </header>

      <section className="mb-12 flex flex-col items-center gap-4 border-y border-border py-12">
        <span className="font-mono text-7xl tabular-nums" aria-hidden>
          {session ? formatClock(remaining) : '25:00'}
        </span>
        {session && (
          <span className="h-1 w-56 overflow-hidden rounded-full bg-border" aria-hidden>
            <span className="block h-full bg-hematoxylin" style={{ width: `${progress * 100}%` }} />
          </span>
        )}
        {/* The controls live in the dialog now, and so does the bar that keeps
            the time on every other screen. This page is the history. */}
        <div className="flex gap-2">
          <Button onClick={focus.open}>
            <Timer /> {session ? 'Open timer' : 'Start focus'}
          </Button>
          <Button variant="outline" onClick={() => navigate(paths.study())}>
            Study
          </Button>
        </div>
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
