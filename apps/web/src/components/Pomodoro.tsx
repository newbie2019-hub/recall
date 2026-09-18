import { Coffee, Square, Timer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { formatClock, usePomodoro } from '@/hooks/usePomodoro'

/**
 * The focus timer, small enough to sit in the study header.
 *
 * It does not advance on its own. When 25 minutes are up the block is closed
 * and the next one waits for a tap, because a break nobody took must not be
 * logged as a break — these rows are read back against review accuracy, and a
 * fabricated one would quietly poison that.
 */
export function Pomodoro({
  deckId = null,
  className,
}: {
  deckId?: string | null
  className?: string
}) {
  const { session, remaining, progress, finished, start, stop, dismiss } = usePomodoro(deckId)

  if (session) {
    const breaking = session.kind === 'break'
    return (
      <div className={cn('flex items-center gap-2', className)}>
        <span
          className={cn(
            'font-mono text-xs tabular-nums',
            breaking ? 'text-muted-foreground' : 'text-hematoxylin',
          )}
          // The minute is the unit people act on; seconds are for the display.
          aria-label={`${Math.ceil(remaining / 60_000)} minutes left in this ${session.kind} block`}
        >
          {formatClock(remaining)}
        </span>
        <span aria-hidden className="h-1 w-10 overflow-hidden rounded-full bg-border">
          <span
            className={cn('block h-full', breaking ? 'bg-muted-foreground' : 'bg-hematoxylin')}
            style={{ width: `${progress * 100}%` }}
          />
        </span>
        <Button variant="ghost" size="icon-xs" onClick={stop} aria-label="Stop the timer">
          <Square />
        </Button>
      </div>
    )
  }

  if (finished) {
    const next = finished === 'focus' ? 'break' : 'focus'
    return (
      <div className={cn('flex items-center gap-1', className)}>
        <Button variant="outline" size="xs" onClick={() => void start(next)}>
          {next === 'break' ? <Coffee /> : <Timer />}
          {next === 'break' ? 'Break' : 'Focus'}
        </Button>
        <Button variant="ghost" size="xs" onClick={dismiss}>
          Not now
        </Button>
      </div>
    )
  }

  return (
    <Button
      variant="ghost"
      size="xs"
      className={className}
      onClick={() => void start('focus')}
      aria-label="Start a 25 minute focus block"
    >
      <Timer /> 25:00
    </Button>
  )
}
