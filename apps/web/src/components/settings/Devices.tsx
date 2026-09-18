import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import type { DeviceSummary } from '@recall/core'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { useAuth } from '@/lib/auth'
import { paths } from '@/routes/paths'

/** Relative where it helps ("2 hours ago"), absolute once it stops helping. */
function lastSeen(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return 'unknown'
  const mins = Math.round((ms - Date.now()) / 60_000)
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (Math.abs(mins) < 60) return rtf.format(mins, 'minute')
  if (Math.abs(mins) < 60 * 24) return rtf.format(Math.round(mins / 60), 'hour')
  if (Math.abs(mins) < 60 * 24 * 14) return rtf.format(Math.round(mins / 1440), 'day')
  return new Date(ms).toLocaleDateString()
}

/**
 * One row per token (PLAN.md §2.6).
 *
 * The distinction this screen exists to hold: **sign out and revoke are not the
 * same thing.** Sign out drops a token and keeps the device row and its cursor,
 * so that phone resumes where it left off. Revoke deletes both, so it signs the
 * phone out *and* makes its next sync a full re-pull. Blurring them is how
 * someone revokes their own laptop expecting "log me out" and then waits twenty
 * minutes for a collection they already had.
 */
export function Devices() {
  const { user, client, signOut, loading } = useAuth()
  const [devices, setDevices] = useState<DeviceSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<DeviceSummary | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!user) return
    try {
      setDevices(await client.devices())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [client, user])

  useEffect(() => void load(), [load])

  if (loading) return <p className="text-sm text-muted-foreground">Checking your session…</p>

  if (!user) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Devices belong to an account. This one is studying on its own.
        </p>
        <Button asChild variant="outline">
          <Link to={paths.signIn}>Sign in</Link>
        </Button>
      </div>
    )
  }

  async function revoke(device: DeviceSummary) {
    setBusy(true)
    try {
      await client.revokeDevice(device.id)
      setConfirming(null)
      if (device.current) {
        // The token this tab is holding is the one that just died. Signing out
        // locally is bookkeeping, not a second decision — and it never touches
        // a row of the collection.
        await signOut()
        toast('This device was revoked. Your collection is still here.')
      } else {
        toast(`${device.name} was signed out and its sync cursor removed.`)
        await load()
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      {error && (
        <p className="text-sm text-eosin">
          Couldn't reach the server — {error}. The list below may be stale; nothing on this
          device is affected.
        </p>
      )}

      <ul>
        {devices?.map((d) => (
          <li key={d.id} className="flex items-center gap-3 border-b border-border py-3 last:border-0">
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 text-sm">
                <span className="truncate">{d.name}</span>
                {d.current && (
                  <Badge variant="outline" className="text-hematoxylin">This device</Badge>
                )}
              </p>
              <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                {d.platform ?? 'unknown'} · seen {lastSeen(d.last_seen_at)} · synced to revision{' '}
                {d.cursor}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="text-eosin"
              disabled={busy}
              onClick={() => setConfirming(d)}
            >
              Revoke
            </Button>
          </li>
        ))}
        {devices && !devices.length && (
          <li className="py-10 text-center text-sm text-muted-foreground">No devices yet.</li>
        )}
        {!devices && !error && (
          <li className="py-10 text-center text-sm text-muted-foreground">Loading…</li>
        )}
      </ul>

      <Dialog open={!!confirming} onOpenChange={busy ? undefined : () => setConfirming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke {confirming?.name}?</DialogTitle>
            <DialogDescription>
              {confirming?.current
                ? 'This is the device you are using right now.'
                : 'That device is signed out the next time it reaches the server.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              Revoking deletes its token <em>and</em> its sync cursor. The collection on that
              device is untouched — nothing there is erased — but when someone signs in on it
              again it re-downloads the account from the beginning instead of resuming.
            </p>
            <p>
              To simply sign a device out and let it pick up where it stopped, use Sign out on
              that device.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirming(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => confirming && void revoke(confirming)}
            >
              Revoke
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
