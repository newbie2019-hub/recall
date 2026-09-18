import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import { collectionReady } from '@/db/boot'
import { deckSizes, offlineDecks, setDeckOffline, type DeckSize } from '@/db/queries/settings'
import { formatBytes, rollUp } from './rollup'

interface Quota {
  usage: number
  quota: number
  persisted: boolean
}

/**
 * What is on this device, and what stays here.
 *
 * The persistence line is the important one and it is reported rather than
 * claimed: `navigator.storage.persist()` is a request a browser can refuse, and
 * Safari evicts after seven idle days when it is refused. Telling someone their
 * data is safe when the browser has not agreed is the one sentence this screen
 * must never print.
 */
export function Storage() {
  const [quota, setQuota] = useState<Quota | null>(null)
  const [decks, setDecks] = useState<DeckSize[] | null>(null)
  const [offline, setOffline] = useState<Map<string, boolean>>(new Map())

  const measure = useCallback(async () => {
    const [estimate, persisted] = await Promise.all([
      navigator.storage?.estimate?.() ?? Promise.resolve(undefined),
      navigator.storage?.persisted?.() ?? Promise.resolve(false),
    ])
    setQuota({ usage: estimate?.usage ?? 0, quota: estimate?.quota ?? 0, persisted })
  }, [])

  useEffect(() => {
    void measure()
    void (async () => {
      await collectionReady
      const [sizes, flags] = await Promise.all([deckSizes(), offlineDecks()])
      setDecks(sizes)
      setOffline(flags)
    })()
  }, [measure])

  async function requestPersistence() {
    const granted = await navigator.storage?.persist?.()
    await measure()
    toast(
      granted
        ? 'This browser will keep your collection until you delete it.'
        : "The browser turned the request down. It usually grants it once the app has been used a few times, or if you install it.",
    )
  }

  async function toggle(deckId: string, keep: boolean) {
    // Optimistic: a switch that waits on a worker round-trip feels broken, and
    // the only cost of being wrong is a flag that reverts on reload.
    setOffline((prev) => new Map(prev).set(deckId, keep))
    try {
      await setDeckOffline(deckId, keep)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    }
  }

  const totals = decks ? rollUp(decks) : null
  const pct = quota?.quota ? Math.min(100, Math.round((quota.usage / quota.quota) * 100)) : 0

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="flex items-baseline justify-between gap-4">
          <h3 className="text-sm font-medium">This browser's storage</h3>
          <p className="font-mono text-xs text-muted-foreground">
            {quota ? `${formatBytes(quota.usage)} of ${formatBytes(quota.quota)}` : '…'}
          </p>
        </div>
        <Progress value={pct} />
        {quota && (
          <p className="text-sm text-muted-foreground">
            {quota.persisted ? (
              <>
                Persistent. The browser will not evict your collection to reclaim space — only
                you can delete it.
              </>
            ) : (
              <>
                Best-effort. The browser may evict the collection under storage pressure, and
                Safari clears it after seven idle days.
              </>
            )}
          </p>
        )}
        {quota && !quota.persisted && (
          <Button variant="outline" size="sm" onClick={() => void requestPersistence()}>
            Ask for persistent storage
          </Button>
        )}
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium">Keep offline</h3>
        <p className="text-sm text-muted-foreground">
          Sizes are estimates: they count each deck's notes, its cards and the images and audio
          those notes reference, and a file used by two decks is counted in both. Turning a deck
          off tells the next sync it may drop that deck's media from this device — the rows and
          your review history never leave.
        </p>
        <ul>
          {decks?.map((d) => {
            const t = totals?.get(d.id)
            return (
              <li key={d.id} className="flex items-center gap-3 border-b border-border py-3 last:border-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{d.name}</p>
                  <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                    {t?.cards ?? 0} cards · {formatBytes(t?.bytes ?? 0)} media
                  </p>
                </div>
                <Switch
                  checked={offline.get(d.id) ?? true}
                  aria-label={`Keep ${d.name} on this device`}
                  onCheckedChange={(v) => void toggle(d.id, v)}
                />
              </li>
            )
          })}
          {decks && !decks.length && (
            <li className="py-10 text-center text-sm text-muted-foreground">No decks yet.</li>
          )}
          {!decks && <li className="py-10 text-center text-sm text-muted-foreground">Measuring…</li>}
        </ul>
      </section>
    </div>
  )
}
