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
 * The running block, pinned to the bottom of every screen.
 *
 * Deliberately quiet — a thin bar, a monospace clock and one control. It is
 * there to answer "how long have I got" at a glance without leaving the card
 * you are on, and a bar that draws attention is a bar that competes with the
 * thing it exists to protect.
 *
 * It renders nothing when no block is running, so it costs nothing on the
 * screens of anyone who never uses it.
 */
function FocusBar({ onOpen }: { onOpen: () => void }) {
  const { session, remaining, progress, finished, stop, dismiss } = usePomodoro()

  if (!session && !finished) return null

  const isBreak = session?.kind === 'break'

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-border bg-background/95 py-1.5 pr-1.5 pl-4 shadow-lg backdrop-blur">
        <button
          onClick={onOpen}
          className="flex items-center gap-2.5 text-left"
          aria-label={session ? `${formatClock(remaining)} left — open the focus timer` : 'Focus block finished'}
        >
          {isBreak ? (
            <Coffee className="size-3.5 text-muted-foreground" />
          ) : (
            <Timer className="size-3.5 text-hematoxylin" />
          )}
          <span className="font-mono text-sm tabular-nums">
            {session ? formatClock(remaining) : 'Done'}
          </span>
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {session ? (isBreak ? 'break' : 'focus') : finished === 'focus' ? 'take five' : 'back to work'}
          </span>
          {session && (
            <span className="hidden h-1 w-16 overflow-hidden rounded-full bg-border sm:block" aria-hidden>
              <span
                className={cn('block h-full transition-[width] duration-1000 ease-linear',
                  isBreak ? 'bg-muted-foreground' : 'bg-hematoxylin')}
                style={{ width: `${progress * 100}%` }}
              />
            </span>
          )}
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
