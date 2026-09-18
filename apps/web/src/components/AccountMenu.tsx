import { Link } from 'react-router'
import { LogIn } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth, type SyncStatus } from '@/lib/auth'
import { paths } from '@/routes/paths'

/**
 * Who this collection is about to sync to, in the app chrome.
 *
 * The email is the point of this component, not decoration. Signing into
 * account B on a device already holding account A's rows adopts them, silently
 * and by design (PHASES §5) — so the account receiving them has to be readable
 * at any moment without navigating anywhere, or a borrowed laptop donates
 * somebody's history to a name they never saw. Name, address and sync state sit
 * together for the same reason: "who am I" and "is my work safe" are one
 * question here.
 *
 * Signed out it is a plain link to sign-in. Never a redirect, never a wall —
 * this component is the *only* way into the auth pages from the app.
 */
export function AccountMenu() {
  const { user, status, loading } = useAuth()

  // Reserving the space stops the header jumping when the stored token resolves.
  if (loading) return <Skeleton className="h-9 w-40" />

  if (!user) {
    return (
      <Button variant="outline" size="sm" asChild>
        <Link to={paths.signIn}>
          <LogIn /> Sign in
        </Link>
      </Button>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex max-w-[15rem] items-center gap-2 rounded-md border border-border px-2 py-1 text-left hover:bg-accent"
          aria-label={`Signed in as ${user.email} — ${SYNC[status].label}`}
        >
          <span
            aria-hidden
            className="grid size-7 shrink-0 place-items-center rounded-full bg-muted font-mono text-[0.625rem] tracking-wider text-muted-foreground"
          >
            {initials(user.name)}
          </span>
          <span className="min-w-0 leading-tight">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-xs font-medium">{user.name}</span>
              <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${SYNC[status].dot}`} />
            </span>
            {/* Always on screen, never only inside the open menu. */}
            <span className="block truncate text-[0.6875rem] text-muted-foreground">
              {user.email}
            </span>
          </span>
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="grid gap-0.5">
          <span className="truncate text-sm">{user.name}</span>
          <span className="truncate text-xs font-normal text-muted-foreground">{user.email}</span>
          <span className={`text-xs font-normal ${SYNC[status].text}`}>{SYNC[status].label}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to={paths.settings()}>Settings</Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to={paths.settings('devices')}>Devices &amp; sign out</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * No traffic light: paused is eosin because it is the odd one out, not because
 * it is an error — nothing is lost, the queue has simply stopped draining.
 */
const SYNC: Record<SyncStatus, { label: string; dot: string; text: string }> = {
  synced: { label: 'Synced', dot: 'bg-hematoxylin', text: 'text-hematoxylin' },
  paused: { label: 'Sync paused — nothing lost', dot: 'bg-eosin', text: 'text-eosin' },
  'local-only': { label: 'On this device only', dot: 'bg-muted-foreground', text: 'text-muted-foreground' },
}

function initials(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => [...part][0] ?? '')
    .join('')

  // An account named with an emoji or a single glyph still needs something in
  // the circle, and a blank one reads as "not signed in".
  return letters.toUpperCase() || '·'
}
