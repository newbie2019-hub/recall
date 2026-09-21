import { useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { SessionMember, SessionStatus } from '@/lib/collab/session'

/**
 * Who else is studying this deck right now, and what the room has got through.
 *
 * `/study` sits outside `AppShell` on purpose — it is the one screen with
 * nothing to click but the four ratings — so this line is an exception that has
 * to keep earning itself, and every decision here is a way of costing less:
 *
 * **One line, above the card.** Never beside the ratings, where it would sit in
 * the path of the hand that is about to grade, and never tall enough to push
 * the card down the screen.
 *
 * **It only moves when somebody answers.** The numbers come from
 * `StudySession`, which fires its callback on a change and swallows the ten
 * second heartbeat, so a card can sit unanswered for a minute with nothing on
 * screen shifting. A live counter ticking during retrieval is the same mistake
 * as chat during retrieval.
 *
 * **The total is large and the names are small, in join order.** There is no
 * sort by count here and there must not be one: the metrics design rules out
 * peer comparison because it helps the people who are already ahead and
 * demotivates the ones who joined a study group for help. "We have answered 240
 * between us" is the claim; "you are 4th of 5" is the thing not to build.
 *
 * **Dismissible.** The most likely outcome of this whole feature is that
 * studying gets slightly worse for everybody, so the way out ships on day one
 * and whether people take it is the thing to watch.
 */

const KEY = 'recall.session_strip_hidden'

const LABEL: Record<SessionMember['state'], string> = {
  studying: '',
  // Not "idle", which reads as a rebuke aimed at the one person in the room who
  // has finished the deck.
  'caught-up': 'caught up',
  idle: 'away',
}

export function SessionStrip({
  members,
  total,
  status,
}: {
  members: SessionMember[]
  total: number
  status: SessionStatus
}) {
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(KEY) === '1'
    } catch {
      return false
    }
  })

  if (status === 'idle' || hidden) return null

  const dismiss = () => {
    setHidden(true)
    try {
      localStorage.setItem(KEY, '1')
    } catch {
      // A blocked or full storage costs the memory of the dismissal, never the
      // dismissal — the same trade `recall.collapsed_decks` makes.
    }
  }

  return (
    <div
      className="mt-2 flex items-baseline gap-3 overflow-hidden border-b border-border pb-2"
      // Said out loud rather than implied, because §4 of the plan is only
      // honest while it is: nothing verifies these numbers and nothing needs to,
      // since there is no ranking here to win.
      title="Counts come from each person's own device. Everybody studies their own cards — your schedule and your due counts are yours alone."
    >
      <span className="flex shrink-0 items-baseline gap-1.5">
        <span className="font-display text-xl leading-none tabular-nums">{total}</span>
        <span className="font-sans text-[0.625rem] tracking-[0.18em] text-muted-foreground uppercase">
          together
        </span>
      </span>

      <span className="flex min-w-0 flex-1 items-baseline gap-3 overflow-hidden font-mono text-[0.625rem] whitespace-nowrap text-muted-foreground">
        {members.map((m) => (
          <span key={m.id} className="truncate">
            {m.name} <span className="tabular-nums text-foreground">{m.answered}</span>
            {LABEL[m.state] && <span className="opacity-60"> · {LABEL[m.state]}</span>}
          </span>
        ))}
        {members.length < 2 && <span>Nobody else yet — the room is open.</span>}
      </span>

      <Button
        variant="ghost"
        size="icon-sm"
        className="-my-1 shrink-0 text-muted-foreground"
        onClick={dismiss}
        aria-label="Hide the session strip"
      >
        <X />
      </Button>
    </div>
  )
}
