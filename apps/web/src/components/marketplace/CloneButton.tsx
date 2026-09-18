import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { Download, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { collectionReady } from '@/db/boot'
import { cloneOf, installVersion, type ClonedDeck } from '@/db/queries/marketplace'
import { useAuth } from '@/lib/auth'
import {
  formatBytes, getVersion, recordInstall, updateAvailable, type Listing,
} from '@/lib/marketplace'
import { paths } from '@/routes/paths'

/**
 * Clone: download the published version and write it into this collection.
 *
 * Two rules decide everything here.
 *
 * **A cloned deck is the cloner's own.** `source_listing_id` exists so an update
 * can be *offered*; nothing upstream ever applies by itself, and the publisher
 * can never reach into a deck that has left. An update is the same install run
 * again: notes are matched by a guid derived from the published one, so the
 * cards and the scheduling built on them survive it.
 *
 * **Cloning twice must not make two copies.** `source_listing_id` is how that is
 * known — it is looked up before the button is drawn and written as part of the
 * install.
 *
 * Telling the server is a separate, optional step. It feeds `install_count` and
 * "which of my decks came from where", and it needs an account; cloning signed
 * out works, and the local row is what actually drives the update offer.
 */
export function CloneButton({ listing }: { listing: Listing }) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [clone, setClone] = useState<ClonedDeck | null | undefined>(undefined)
  const [stage, setStage] = useState<'downloading' | 'importing' | null>(null)
  const [progress, setProgress] = useState(0)

  const refresh = useCallback(async () => {
    await collectionReady
    setClone(await cloneOf(listing.id))
  }, [listing.id])

  useEffect(() => void refresh(), [refresh])

  const latest = listing.versions?.find((v) => v.version === listing.latest_version)

  async function run() {
    setStage('downloading')
    setProgress(0)
    try {
      const version = await getVersion(listing.id, listing.latest_version)
      setStage('importing')
      const result = await installVersion(
        listing.id,
        listing.latest_version,
        version.payload,
        (done, total) => setProgress(total ? Math.round((done / total) * 100) : 100),
      )

      // Bookkeeping, and never a reason to fail a clone that has already
      // landed: the deck is in the collection whether or not the server hears
      // about it, and signed out there is nobody to tell.
      if (user) {
        await recordInstall(listing.id, result.deckId, listing.latest_version).catch(() => {})
      }

      await refresh()
      toast(`${result.added} notes added, ${result.updated} updated`, {
        action: { label: 'Open', onClick: () => navigate(paths.deck(result.deckId)) },
      })
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setStage(null)
    }
  }

  const busy = stage !== null
  const canUpdate = updateAvailable(clone ?? null, listing)

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {clone === null || canUpdate ? (
          <Button size="lg" disabled={busy} onClick={() => void run()}>
            {canUpdate ? <RefreshCw /> : <Download />}
            {canUpdate ? `Update to v${listing.latest_version}` : 'Add to my collection'}
          </Button>
        ) : clone ? (
          <Button size="lg" variant="outline" onClick={() => navigate(paths.deck(clone.id))}>
            Open “{clone.name}”
          </Button>
        ) : null}

        {clone && canUpdate && (
          <Button variant="ghost" onClick={() => navigate(paths.deck(clone.id))}>
            Open your copy
          </Button>
        )}
      </div>

      {clone && (
        <p className="mt-2 text-xs text-muted-foreground">
          {canUpdate
            ? `You have v${clone.source_version ?? '?'}. Updating matches notes by id, so your ` +
              'scheduling stays, and cards the update does not mention are left alone.'
            : 'This deck is yours now — the person who published it cannot change or remove your copy.'}
        </p>
      )}

      <Dialog open={busy}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{clone ? 'Updating' : 'Adding to your collection'}</DialogTitle>
            <DialogDescription>
              {stage === 'downloading'
                ? `Downloading${latest ? ` ${formatBytes(latest.size_bytes)}` : ''}…`
                : 'Writing notes into your collection…'}
            </DialogDescription>
          </DialogHeader>
          <Progress value={stage === 'importing' ? progress : 0} />
          <p className="text-xs text-muted-foreground">
            A large deck takes a while. Notes are written in batches that each
            stand on their own, so nothing is left half-imported.
          </p>
        </DialogContent>
      </Dialog>
    </>
  )
}
