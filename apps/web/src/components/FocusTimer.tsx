import { createContext, useContext, useState, type ReactNode } from 'react'
import { Coffee, Square, Timer, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { formatClock, usePomodoro } from '@/hooks/usePomodoro'
import { cn } from '@/lib/utils'

/**
 * The focus timer, as a dialog you dismiss and a bar you cannot lose.
 *
 * It used to be a screen, which is the wrong shape for it: a focus block exists
 * so you can go and *study*, and a timer that only exists on its own page means
 * either watching the clock instead of working, or starting a block and never
 * seeing it again. So the controls are a dialog — open it, start, get on with
 * it — and a running block leaves a bar pinned to the bottom of whatever screen
 * you are on.
 *
 * Both halves read the same `usePomodoro`, and that hook reads the open block
 * out of the collection rather than holding it in memory, so the bar is correct
 * after a reload, in a second tab, and on a phone that suspended the page for
 * an hour. The clock is derived from `started_at` and the wall clock for the
 * same reason — counted ticks stop when a tab is backgrounded.
 */

const FocusContext = createContext<{ open: () => void } | null>(null)

/** Open the timer from anywhere inside the shell. */
export function useFocus(): { open: () => void } {
  return useContext(FocusContext) ?? { open: () => {} }
}

export function FocusProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)

  return (
    <FocusContext.Provider value={{ open: () => setOpen(true) }}>
      {children}
      <FocusDialog open={open} onOpenChange={setOpen} />
      <FocusBar onOpen={() => setOpen(true)} />
    </FocusContext.Provider>
  )
}

function FocusDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { session, remaining, progress, finished, start, stop, dismiss } = usePomodoro()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Focus</DialogTitle>
          <DialogDescription>
            {session
              ? session.kind === 'break'
                ? 'Five minutes off. The bar at the bottom keeps the time.'
                : 'Twenty-five minutes. Close this and study — the bar keeps the time.'
              : 'Twenty-five minutes of work, then five off.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-5 py-4">
          {/* Decorative: it repaints every second and a screen reader would
              announce each one. The buttons carry the meaning. */}
          <span className="font-mono text-6xl tabular-nums" aria-hidden>
            {session ? formatClock(remaining) : '25:00'}
          </span>

          <span className="h-1 w-48 overflow-hidden rounded-full bg-border" aria-hidden>
            <span
              className="block h-full bg-hematoxylin transition-[width] duration-1000 ease-linear"
              style={{ width: `${(session ? progress : 0) * 100}%` }}
            />
          </span>

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
              <Button variant="ghost" onClick={dismiss}>Not now</Button>
            </div>
          ) : (
            <Button onClick={() => void start('focus')}>
              <Timer /> Start focus
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The running block, pinned to the bottom-left of every screen.
 *
 * Left rather than centre: centred, it sat under the primary button on half the
 * screens in the app — *Study now*, *Add note*, *Save* — and a floating pill
 * over the thing you came to press is a timer competing with the work it exists
 * to protect. The corner is out of the way and still in the eyeline.
 *
 * The clock is a **depleting ring**, which is the one piece of motion worth
 * having here: it is legible at a glance with no reading, it says "running"
 * without a second element, and it is a single `stroke-dashoffset` that the
 * browser interpolates — no animation library, no timer loop driving a
 * repaint. The pill slides up once on arrival and the ring breathes gently
 * while a focus block runs; both stop dead under `prefers-reduced-motion`,
 * because motion in the corner of the eye is exactly what that setting is for.
 *
 * It renders nothing when no block is running, so it costs nothing on the
 * screens of anyone who never uses it.
 */
function FocusBar({ onOpen }: { onOpen: () => void }) {
  const { session, remaining, progress, finished, stop, dismiss } = usePomodoro()

  if (!session && !finished) return null

  const isBreak = session?.kind === 'break'

  return (
    <div className="pointer-events-none fixed bottom-0 left-0 z-50 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <div
        className="pointer-events-auto flex items-center gap-2.5 rounded-full border border-border
                   bg-background/95 py-1.5 pr-1.5 pl-2 shadow-lg backdrop-blur
                   motion-safe:animate-[focus-in_320ms_cubic-bezier(0.22,1,0.36,1)]"
      >
        <button
          onClick={onOpen}
          className="flex items-center gap-2.5 text-left"
          aria-label={session ? `${formatClock(remaining)} left — open the focus timer` : 'Focus block finished'}
        >
          <FocusRing progress={session ? progress : 1} breathing={!!session && !isBreak}>
            {isBreak ? (
              <Coffee className="size-3 text-muted-foreground" />
            ) : (
              <Timer className="size-3 text-hematoxylin" />
            )}
          </FocusRing>
          <span className="font-mono text-sm tabular-nums">
            {session ? formatClock(remaining) : 'Done'}
          </span>
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {session ? (isBreak ? 'break' : 'focus') : finished === 'focus' ? 'take five' : 'back to work'}
          </span>
        </button>

        <Button
          variant="ghost"
          size="icon-sm"
          className="rounded-full"
          aria-label={session ? 'Stop the block' : 'Dismiss'}
          onClick={session ? stop : dismiss}
        >
          {session ? <Square /> : <X />}
        </Button>
      </div>
    </div>
  )
}

/**
 * The clock, as a ring that empties.
 *
 * One `stroke-dashoffset` the browser interpolates over a second, so the sweep
 * is smooth while the hook only ticks once a second — animating the value
 * rather than repainting at 60fps is the whole trick, and it costs nothing when
 * the tab is hidden because the compositor stops with it.
 *
 * The breathing is deliberately slight (a 4% scale over four seconds) and only
 * on a *focus* block: a break that pulses at you is the opposite of a break.
 * Both it and the entrance are `motion-safe`, so the whole thing is static for
 * anyone who has asked for that.
 */
function FocusRing({
  progress, breathing, children,
}: { progress: number; breathing: boolean; children: ReactNode }) {
  const R = 13
  const C = 2 * Math.PI * R

  return (
    <span className={cn('relative grid size-8 place-items-center',
      breathing && 'motion-safe:animate-[focus-breathe_4s_ease-in-out_infinite]')}>
      <svg viewBox="0 0 32 32" className="absolute inset-0 -rotate-90" aria-hidden>
        <circle cx="16" cy="16" r={R} fill="none" strokeWidth="2.5" className="stroke-border" />
        <circle
          cx="16" cy="16" r={R} fill="none" strokeWidth="2.5" strokeLinecap="round"
          className={cn('transition-[stroke-dashoffset] duration-1000 ease-linear',
            breathing ? 'stroke-hematoxylin' : 'stroke-muted-foreground')}
          strokeDasharray={C}
          // Full ring at the start of a block, empty at the end.
          strokeDashoffset={C * Math.min(1, Math.max(0, progress))}
        />
      </svg>
      {children}
    </span>
  )
}
