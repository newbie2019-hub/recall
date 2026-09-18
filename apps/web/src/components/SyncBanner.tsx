import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { CloudOff } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { db } from '@/db/client'
import { collectionReady } from '@/db/boot'
import { useAuth } from '@/lib/auth'
import { paths } from '@/routes/paths'

/**
 * The sync state, in the one case where it is worth a row of the screen.
 *
 * Three states exist (`synced` · `paused` · `local-only`) and only one of them
 * earns a banner. `synced` and `local-only` are both "nothing is wrong", and a
 * strip that says so permanently is a nag people stop reading — which is
 * exactly when the one that matters stops being read too. Those two are
 * reported instead by `AccountMenu`, which is in the header of every screen
 * that mounts this, so the state is still answerable at a glance.
 *
 * `paused` is one banner: what is queued, a way to try again, and a way to sign
 * in if the token is what expired. Never a modal and never a blocker — a 401
 * must not take the collection away (PHASES §5), and the person keeps studying
 * while it is on screen.
 */
export function SyncBanner() {
  const { status, client, reportSync } = useAuth()
  const [queued, setQueued] = useState<{ reviews: number; deletions: number } | null>(null)
  const [retrying, setRetrying] = useState(false)

  useEffect(() => {
    if (status !== 'paused') return
    let cancelled = false
    void (async () => {
      await collectionReady
      const [row] = await db.select<{ reviews: number; deletions: number }>(
        `SELECT (SELECT COUNT(*) FROM reviews    WHERE synced = 0) AS reviews,
                (SELECT COUNT(*) FROM tombstones WHERE synced = 0) AS deletions`,
      )
      if (!cancelled) setQueued(row ?? null)
    })()
    return () => {
      cancelled = true
    }
    // Re-counts on every entry into `paused`, not on a timer: the count only
    // moves while reviewing, and a polling banner would wake the worker on a
    // screen nobody is looking at.
  }, [status])

  const retry = useCallback(async () => {
    setRetrying(true)
    try {
      // The cheapest request that proves the token and the network at once.
      await client.me()
      reportSync(true)
    } catch {
      reportSync(false)
    } finally {
      setRetrying(false)
    }
  }, [client, reportSync])

  if (status !== 'paused') return null

  return (
    <Alert className="mb-6">
      <CloudOff />
      <AlertTitle>Sync paused — everything is still here</AlertTitle>
      <AlertDescription>
        <p>
          {describe(queued)} It goes up as soon as this device can reach the server again.
        </p>
        <div className="mt-2 flex gap-2">
          <Button size="sm" variant="outline" onClick={() => void retry()} disabled={retrying}>
            {retrying ? 'Trying…' : 'Try again'}
          </Button>
          <Button size="sm" variant="ghost" asChild>
            <Link to={paths.signIn}>Sign in again</Link>
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  )
}

/** Vague until the count is in, rather than flashing a wrong "0 reviews". */
function describe(queued: { reviews: number; deletions: number } | null): string {
  if (!queued) return 'Your recent work is waiting on this device.'

  const parts = [
    queued.reviews > 0 ? `${queued.reviews} review${queued.reviews === 1 ? '' : 's'}` : null,
    queued.deletions > 0 ? `${queued.deletions} deletion${queued.deletions === 1 ? '' : 's'}` : null,
  ].filter((p): p is string => p !== null)

  if (!parts.length) return 'Nothing is waiting to be sent.'

  return `${parts.join(' and ')} waiting on this device.`
}
