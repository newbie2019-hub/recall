import { Link } from 'react-router'
import { LogIn } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Avatar } from '@/components/Avatar'
import { useFocus } from '@/components/FocusTimer'
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
 * Signed out it is a plain link to sign-in. It is no longer the *only* way into
 * the auth pages — `RequireAuth` sends people there now — but it is still the
 * only one on the public marketplace screens, which a visitor can reach with no
 * account at all.
 */
export function AccountMenu() {
  const { user, status, loading } = useAuth()
  const focus = useFocus()

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
          className="flex max-w-[18rem] items-center gap-2.5 rounded-md py-1 text-left"
          aria-label={`Signed in as ${user.email} — ${SYNC[status].label}`}
        >
          {/* Name and address sit *before* the avatar and carry no chrome of
              their own — the bar already has a border, and a second box drawn
              inside it made the account look like a button among buttons when
              it is really a statement of fact. */}
          <span className="hidden min-w-0 text-right leading-tight sm:block">
            <span className="flex items-center justify-end gap-1.5">
              <span className="truncate text-xs font-medium">{user.name}</span>
              <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${SYNC[status].dot}`} />
            </span>
            <span className="block truncate text-[0.6875rem] text-muted-foreground">
              {user.email}
            </span>
          </span>
          <Avatar user={user} className="size-8" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="grid gap-0.5">
          <span className="truncate text-sm">{user.name}</span>
          <span className="truncate text-xs font-normal text-muted-foreground">{user.email}</span>
          <span className={`text-xs font-normal ${SYNC[status].text}`}>{SYNC[status].label}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={focus.open}>Focus timer</DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to={paths.pomodoro}>Focus history</Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to={paths.settings()}>Settings</Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to={paths.myListings}>Your published decks</Link>
        </DropdownMenuItem>
        {/* Drawn only for a moderator, but never the authorization itself —
            `can:moderate` on the server is, and the queue 403s regardless. */}
        {user.is_moderator && (
          <DropdownMenuItem asChild>
            <Link to={paths.moderation}>Moderation queue</Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
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
