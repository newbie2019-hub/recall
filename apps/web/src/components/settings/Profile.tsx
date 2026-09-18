import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { useAuth } from '@/lib/auth'
import { paths } from '@/routes/paths'
import {
  collectionCounts, eraseLocalCollection, type CollectionCounts,
} from '@/db/queries/settings'

/**
 * Who you are on this device, and the only way out.
 *
 * Signed out this section stays put and says so rather than disappearing: a
 * settings page whose first entry vanishes for half the users teaches them the
 * page is unreliable, and signing in is a state, not a gate (PLAN.md §2.6).
 */
export function Profile() {
  const { user, status, loading } = useAuth()
  const [signingOut, setSigningOut] = useState(false)

  if (loading) return <p className="text-sm text-muted-foreground">Checking your session…</p>

  if (!user) {
    return (
      <div className="space-y-4">
        <p className="text-sm">
          You're studying without an account. Every card, review and image is on this device
          and stays there.
        </p>
        <p className="text-sm text-muted-foreground">
          An account adds sync and a copy on the server. Signing in{' '}
          <strong className="font-medium text-foreground">adopts this collection</strong> into
          the account you sign into — nothing here is destroyed or replaced.
        </p>
        <Button asChild>
          <Link to={paths.signIn}>Sign in or create an account</Link>
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <dl className="grid gap-4 sm:grid-cols-[8rem_1fr]">
        <dt className="text-sm text-muted-foreground">Name</dt>
        <dd className="text-sm">{user.name}</dd>
        <dt className="text-sm text-muted-foreground">Email</dt>
        <dd className="flex flex-wrap items-center gap-2 text-sm">
          {user.email}
          {user.email_verified ? (
            <Badge variant="outline" className="text-hematoxylin">Verified</Badge>
          ) : (
            <Badge variant="outline" className="text-eosin">Unverified</Badge>
          )}
        </dd>
        <dt className="text-sm text-muted-foreground">Sync</dt>
        <dd className="text-sm">
          {status === 'synced' ? 'Up to date with the server' : 'Paused — reviews are queueing on this device'}
        </dd>
      </dl>

      {!user.email_verified && (
        <p className="text-sm text-muted-foreground">
          Unverified accounts sync normally. Verification only gates publishing a deck to the
          marketplace.
        </p>
      )}

      <Button variant="outline" onClick={() => setSigningOut(true)}>Sign out</Button>

      <SignOutDialog open={signingOut} onOpenChange={setSigningOut} />
    </div>
  )
}

/**
 * Sign-out counts unsynced reviews *before* it offers to clear anything
 * (PHASES §5). Keeping the local collection is the button, not the escape
 * hatch; erasing is a second screen with the counts on it and a word to type.
 */
function SignOutDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { signOut } = useAuth()
  const [counts, setCounts] = useState<CollectionCounts | null>(null)
  const [erasing, setErasing] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setErasing(false)
    setTyped('')
    setCounts(null)
    void collectionCounts().then(setCounts, () => setCounts(null))
  }, [open])

  async function out(wipe: boolean) {
    setBusy(true)
    try {
      // Sign out first. If the wipe ran first and the sign-out then failed, the
      // device would sit there signed in with an empty collection and a cursor
      // that says it is up to date.
      await signOut()
      if (wipe) {
        await eraseLocalCollection()
        // Boot seeds the built-in note types exactly once per page load, so a
        // reload is what puts the collection back into a usable empty state.
        location.assign(paths.decks)
        return
      }
      onOpenChange(false)
      toast('Signed out. Your collection is still on this device.')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const unsynced = counts?.unsynced ?? 0

  return (
    <Dialog open={open} onOpenChange={busy ? undefined : onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{erasing ? 'Erase this device’s collection?' : 'Sign out'}</DialogTitle>
          <DialogDescription>
            {counts === null
              ? 'Counting what is on this device…'
              : erasing
                ? 'This cannot be undone from here.'
                : unsynced > 0
                  ? `${unsynced} ${unsynced === 1 ? 'review has' : 'reviews have'} not reached the server yet.`
                  : 'Everything on this device has reached the server.'}
          </DialogDescription>
        </DialogHeader>

        {counts && !erasing && (
          <p className="text-sm text-muted-foreground">
            Signing out drops this device's token and keeps every row — {counts.cards} cards and{' '}
            {counts.reviews} reviews stay here, and signing back in resumes where the sync left
            off instead of downloading the collection again.
          </p>
        )}

        {counts && erasing && (
          <div className="space-y-3 text-sm">
            <ul className="space-y-1 font-mono text-xs">
              <li>{counts.decks} decks</li>
              <li>{counts.notes} notes · {counts.cards} cards</li>
              <li>{counts.reviews} reviews{unsynced > 0 && <span className="text-eosin"> · {unsynced} never sent</span>}</li>
              <li>{counts.media} media files</li>
            </ul>
            {unsynced > 0 && (
              <p className="text-eosin">
                {unsynced} {unsynced === 1 ? 'review' : 'reviews'} exist only here. Erasing loses
                {unsynced === 1 ? ' it' : ' them'} for good.
              </p>
            )}
            <div className="space-y-2">
              <Label htmlFor="erase-confirm">Type ERASE to confirm</Label>
              <Input
                id="erase-confirm"
                autoComplete="off"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
            </div>
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          {erasing ? (
            <>
              <Button variant="ghost" disabled={busy} onClick={() => setErasing(false)}>Back</Button>
              <Button
                variant="destructive"
                disabled={busy || typed.trim().toUpperCase() !== 'ERASE'}
                onClick={() => void out(true)}
              >
                Sign out and erase
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                className="text-eosin"
                disabled={busy || !counts}
                onClick={() => setErasing(true)}
              >
                Erase local data too
              </Button>
              <Button disabled={busy || !counts} onClick={() => void out(false)}>
                Sign out, keep everything
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
