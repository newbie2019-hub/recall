import { useEffect, useState } from 'react'
import { Download } from 'lucide-react'
import { toast } from 'sonner'
import { ApkgButtons } from '@/components/Apkg'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { collectionReady } from '@/db/boot'
import { collectionCounts, eraseLocalCollection, type CollectionCounts } from '@/db/queries/settings'
import { exportApkg } from '@/lib/anki/export'
import { useAuth } from '@/lib/auth'
import { paths } from '@/routes/paths'
import { formatBytes } from './rollup'

/** Save the whole collection as `.apkg`. Shared by the button and the delete dialog. */
async function downloadApkg(): Promise<void> {
  const out = await exportApkg(null)
  const url = URL.createObjectURL(out.file)
  const a = document.createElement('a')
  a.href = url
  a.download = `recall-${new Date().toISOString().slice(0, 10)}.apkg`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  toast(`Exported ${out.notes} notes, ${out.cards} cards, ${out.reviews} reviews`)
}

export function Data() {
  const { user } = useAuth()
  const [counts, setCounts] = useState<CollectionCounts | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    void (async () => {
      await collectionReady
      setCounts(await collectionCounts())
    })()
  }, [])

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h3 className="text-sm font-medium">Export and import</h3>
        <p className="text-sm text-muted-foreground">
          {counts
            ? `${counts.notes} notes, ${counts.cards} cards, ${counts.reviews} reviews and ${counts.media} media files (${formatBytes(counts.mediaBytes)}).`
            : 'Counting…'}{' '}
          An export is a standard Anki `.apkg` — it opens in Anki, and it carries your review
          history, not just the cards.
        </p>
        <div className="flex flex-wrap gap-2">
          {/* The import dialog reports its own counts, so there is nothing here to refresh. */}
          <ApkgButtons onImported={() => {}} />
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium">Delete your account</h3>
        <p className="text-sm text-muted-foreground">
          {user
            ? 'Deletes the account and everything stored on the server. It is not the same as signing out, and it is not undoable.'
            : 'There is no account on this device, so there is nothing to delete. Signing out and erasing local data lives under Profile.'}
        </p>
        <Button variant="outline" className="text-eosin" disabled={!user} onClick={() => setDeleting(true)}>
          Delete account
        </Button>
      </section>

      <DeleteAccountDialog open={deleting} onOpenChange={setDeleting} counts={counts} />
    </div>
  )
}

/**
 * Deletion is a different action from sign-out and offers an export first
 * (PHASES §5). The export is a real button on the first screen rather than a
 * sentence in small print, because "you can export first" is only true if the
 * dialog stops and lets you.
 */
function DeleteAccountDialog({
  open, onOpenChange, counts,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  counts: CollectionCounts | null
}) {
  const { user, signOut, client } = useAuth()
  const [confirming, setConfirming] = useState(false)
  const [typed, setTyped] = useState('')
  const [wipe, setWipe] = useState(false)
  const [exported, setExported] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setConfirming(false)
    setTyped('')
    setWipe(false)
    setExported(false)
  }, [open])

  async function save() {
    setBusy(true)
    try {
      await downloadApkg()
      setExported(true)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function destroy() {
    setBusy(true)
    try {
      await client.deleteAccount(typed)
      // Local rows are kept unless the person asked otherwise: the account is
      // gone from the server, and that is not a reason to take their cards away
      // from the device they are standing at.
      await signOut()
      if (wipe) await eraseLocalCollection()
      location.assign(paths.decks)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={busy ? undefined : onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete your account</DialogTitle>
          <DialogDescription>
            {confirming
              ? 'Last stop. This cannot be undone.'
              : 'Take a copy first — the server copy goes with the account.'}
          </DialogDescription>
        </DialogHeader>

        {!confirming ? (
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Deleting removes {user?.email} and every deck, note and review the server holds for
              it, on every device that syncs with it.
            </p>
            <Button variant="outline" disabled={busy} onClick={() => void save()}>
              <Download /> {exported ? 'Export again' : 'Export .apkg first'}
            </Button>
            {exported && (
              <p className="text-xs text-muted-foreground">
                Saved. Keep it somewhere that is not this browser.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            {counts && (
              <ul className="space-y-1 font-mono text-xs">
                <li>{counts.notes} notes · {counts.cards} cards</li>
                <li>
                  {counts.reviews} reviews
                  {counts.unsynced > 0 && <span className="text-eosin"> · {counts.unsynced} never sent</span>}
                </li>
              </ul>
            )}
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={wipe}
                onChange={(e) => setWipe(e.target.checked)}
              />
              <span>
                Also erase the copy on this device. Leave this off and your cards stay here,
                offline, exactly as they are.
              </span>
            </label>
            <div className="space-y-2">
              {/* The password rather than the address: the server asks for it
                  too, and the person holding an open session is not always the
                  person who owns the account. Typing an address only proves
                  someone read the screen. */}
              <Label htmlFor="delete-confirm">Enter your password to confirm</Label>
              <Input
                id="delete-confirm"
                type="password"
                autoComplete="current-password"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
            </div>
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          {confirming ? (
            <>
              <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>Back</Button>
              <Button
                variant="destructive"
                disabled={busy || typed.length === 0}
                onClick={() => void destroy()}
              >
                Delete account
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button variant="outline" className="text-eosin" disabled={busy} onClick={() => setConfirming(true)}>
                Continue
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

