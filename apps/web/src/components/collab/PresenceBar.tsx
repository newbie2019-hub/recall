import { Users, Wifi, WifiOff } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { Presence, Status } from '@/lib/collab/provider'

/**
 * Who else is in this deck, and whether their edits are reaching you.
 *
 * The status is not decoration. In a shared document "your edit is saved" and
 * "your edit has reached the other person" are different claims, and only one
 * of them is true while the socket is down — so `offline` says the edits are
 * queued rather than letting a silent UI imply they have landed.
 *
 * Initials rather than avatars: there are no profile pictures in this app, and
 * a coloured circle with a letter in it is honest about that.
 */
export function PresenceBar({
  members,
  status,
  queued = 0,
}: {
  members: Presence[]
  status: Status | 'idle'
  queued?: number
}) {
  if (status === 'idle') return null

  return (
    <div className="flex flex-wrap items-center gap-2 border-y border-border py-2">
      <span className="flex items-center gap-1.5 font-sans text-[0.625rem] tracking-[0.18em] text-muted-foreground uppercase">
        <Users className="size-3" /> Shared
      </span>

      <div className="flex -space-x-1.5">
        {members.map((m) => (
          <span
            key={m.id}
            title={`${m.name} · ${m.role}`}
            className="grid size-6 place-items-center rounded-full border border-background bg-muted font-mono text-[0.5625rem] tracking-wider text-muted-foreground"
          >
            {initials(m.name)}
          </span>
        ))}
        {!members.length && (
          <span className="text-xs text-muted-foreground">Nobody else right now</span>
        )}
      </div>

      <StatusChip status={status} queued={queued} />
    </div>
  )
}

function StatusChip({ status, queued }: { status: Status | 'idle'; queued: number }) {
  if (status === 'live') {
    return (
      <Badge variant="outline" className="gap-1 font-mono text-[0.625rem] text-hematoxylin">
        <Wifi className="size-3" /> live
      </Badge>
    )
  }

  if (status === 'read-only') {
    return (
      <Badge variant="outline" className="font-mono text-[0.625rem]">
        read-only
      </Badge>
    )
  }

  if (status === 'connecting') {
    return (
      <Badge variant="outline" className="font-mono text-[0.625rem] text-muted-foreground">
        connecting…
      </Badge>
    )
  }

  // Offline and error read the same to the person typing: the edits are here
  // and are not yet anywhere else. Saying "nothing is lost" is the whole job of
  // this chip, because the CRDT is what makes it true.
  return (
    <Badge variant="outline" className="gap-1 font-mono text-[0.625rem] text-eosin">
      <WifiOff className="size-3" />
      {queued ? `${queued} edit${queued === 1 ? '' : 's'} waiting` : 'offline'} — nothing lost
    </Badge>
  )
}

function initials(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => [...part][0] ?? '')
    .join('')
  return letters.toUpperCase() || '·'
}
