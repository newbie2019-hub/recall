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
import { Avatar, AvatarArt, AVATARS, initials } from '@/components/Avatar'
import { useAuth } from '@/lib/auth'
import { cn } from '@/lib/utils'
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
    <div className="space-y-10">
      <AvatarPicker />
      <Identity />
      <PasswordChange />

      <div className="space-y-3 border-t border-border pt-6">
        <p className="text-sm text-muted-foreground">
          {status === 'synced'
            ? 'Up to date with the server.'
            : 'Sync paused — reviews are queueing on this device.'}
        </p>
        <Button variant="outline" onClick={() => setSigningOut(true)}>Sign out</Button>
      </div>

      <SignOutDialog open={signingOut} onOpenChange={setSigningOut} />
    </div>
  )
}

/**
 * Pick a face.
 *
 * Saves on click rather than behind a button: there is one field, the choice is
 * visible in the result, and a Save button for a picture is a step that exists
 * only to be forgotten. The bar's avatar updates in the same instant because
 * `refreshUser` rewrites the session the whole app reads.
 */
function AvatarPicker() {
  const { user, client, refreshUser } = useAuth()
  const [saving, setSaving] = useState<string | null>(null)

  async function choose(key: string | null) {
    setSaving(key ?? 'none')
    try {
      await client.updateProfile({ avatar: key })
      await refreshUser()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(null)
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-3">
        <Avatar user={user!} className="size-12" />
        <div>
          <p className="text-sm font-medium">Your picture</p>
          <p className="text-xs text-muted-foreground">
            Drawn, not uploaded — nothing leaves this device but the name of the one you pick.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {AVATARS.map((key) => (
          <button
            key={key}
            type="button"
            disabled={!!saving}
            aria-label={key}
            aria-pressed={user!.avatar === key}
            onClick={() => void choose(key)}
            className={cn(
              'size-11 overflow-hidden rounded-full ring-offset-2 ring-offset-background transition',
              user!.avatar === key ? 'ring-2 ring-hematoxylin' : 'opacity-70 hover:opacity-100',
            )}
          >
            <AvatarArt name={key} />
          </button>
        ))}
        <button
          type="button"
          disabled={!!saving}
          aria-label="Use my initials"
          aria-pressed={!user!.avatar}
          onClick={() => void choose(null)}
          className={cn(
            'grid size-11 place-items-center rounded-full bg-muted font-mono text-[0.625rem] tracking-wider text-muted-foreground ring-offset-2 ring-offset-background transition',
            !user!.avatar ? 'ring-2 ring-hematoxylin' : 'opacity-70 hover:opacity-100',
          )}
        >
          {initials(user!.name)}
        </button>
      </div>
    </section>
  )
}

/**
 * Name and address.
 *
 * **Changing the address un-verifies it**, and the form says so before you
 * change it rather than afterwards — the server does this deliberately, since
 * the old confirmation was proof about a different mailbox, and finding out by
 * losing the ability to publish is a bad way to learn it.
 */
function Identity() {
  const { user, client, refreshUser } = useAuth()
  const [form, setForm] = useState({ name: user!.name, email: user!.email })
  const [busy, setBusy] = useState(false)

  const dirty = form.name.trim() !== user!.name || form.email.trim() !== user!.email
  const emailChanging = form.email.trim() !== user!.email

  async function save() {
    setBusy(true)
    try {
      await client.updateProfile({ name: form.name.trim(), email: form.email.trim() })
      await refreshUser()
      toast('Account updated')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-4 border-t border-border pt-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="profile-name">Name</Label>
          <Input
            id="profile-name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="profile-email">Email</Label>
          <Input
            id="profile-email"
            type="email"
            autoComplete="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
          <p className="flex items-center gap-2 text-xs">
            {user!.email_verified ? (
              <Badge variant="outline" className="text-hematoxylin">Verified</Badge>
            ) : (
              <Badge variant="outline" className="text-eosin">Unverified</Badge>
            )}
            <span className="text-muted-foreground">
              {emailChanging
                ? 'Changing this makes it unverified again.'
                : 'Verification only gates publishing to the marketplace.'}
            </span>
          </p>
        </div>
      </div>

      <div className="flex gap-2">
        <Button disabled={!dirty || busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save changes'}
        </Button>
        {dirty && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => setForm({ name: user!.name, email: user!.email })}
          >
            Cancel
          </Button>
        )}
      </div>
    </section>
  )
}

/**
 * Change the password, proving the old one.
 *
 * The current password is asked for even though the request is already
 * authenticated: a bearer token is something a borrowed laptop has, and this is
 * the one change that would lock its owner out of their own account.
 */
function PasswordChange() {
  const { client } = useAuth()
  const [form, setForm] = useState({ current: '', next: '', confirm: '' })
  const [busy, setBusy] = useState(false)

  const mismatch = form.confirm.length > 0 && form.next !== form.confirm
  const ready = form.current && form.next.length >= 8 && form.next === form.confirm

  async function change() {
    setBusy(true)
    try {
      await client.changePassword({ current_password: form.current, password: form.next })
      setForm({ current: '', next: '', confirm: '' })
      toast('Password changed. Your other devices stay signed in.')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-4 border-t border-border pt-6">
      <div>
        <p className="text-sm font-medium">Password</p>
        <p className="text-xs text-muted-foreground">
          Your other devices keep their sessions — sign them out from Devices if you need to.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="pw-current">Current</Label>
          <Input
            id="pw-current" type="password" autoComplete="current-password"
            value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="pw-next">New</Label>
          <Input
            id="pw-next" type="password" autoComplete="new-password"
            value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="pw-confirm">Repeat</Label>
          <Input
            id="pw-confirm" type="password" autoComplete="new-password"
            value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })}
            aria-invalid={mismatch}
          />
          {mismatch && <p className="text-xs text-eosin">These do not match.</p>}
        </div>
      </div>

      <Button variant="outline" disabled={!ready || busy} onClick={() => void change()}>
        {busy ? 'Changing…' : 'Change password'}
      </Button>
    </section>
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
