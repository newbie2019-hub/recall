import { useEffect } from 'react'
import { collectionReady } from '@/db/boot'
import * as local from '@/db/queries/sync'
import { useAuth } from '@/lib/auth'
import { IDLE_MS, backoffMs, sync } from '@/lib/sync'

/**
 * Runs the sync loop for as long as somebody is signed in. Mount it once.
 *
 * Signed out it does nothing at all, which is the whole three-state design: the
 * collection works with no account, and the only thing an account adds is this
 * timer and a banner (PHASES §5).
 */
export function useSync() {
  const { user, client, reportSync } = useAuth()

  useEffect(() => {
    if (!user) return

    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    let stopped = false

    const run = async () => {
      // The collection has to be open and migrated before the first statement;
      // on a cold load this hook mounts alongside the boot, not after it.
      await collectionReady
      const ok = await sync(client, user.id, local, reportSync)
      failures = ok ? 0 : failures + 1
      if (!stopped) timer = setTimeout(() => void run(), ok ? IDLE_MS : backoffMs(failures))
    }

    /** Back online: drain now rather than waiting out whatever backoff we reached. */
    const wake = () => {
      clearTimeout(timer)
      failures = 0
      void run()
    }

    /**
     * Session end, which is the one that actually matters: Safari evicts site
     * storage after 7 idle days, and an unsent review is the only thing in the
     * product that nothing can rebuild (PHASES §5).
     *
     * `navigator.sendBeacon` cannot do this job. It sends no `Authorization`
     * header and the endpoint is bearer-only, so the request would arrive
     * unauthenticated and be dropped — and it cannot read the response, which is
     * what tells us the rows landed and may be marked synced. So: an ordinary
     * push on the `hidden` transition, which the tab normally survives, and
     * anything that does not make it is still unsent for the next run.
     *
     * ponytail: not guaranteed on a hard kill. `fetch(..., { keepalive: true })`
     * on the push would be — it needs one line in `ApiClient.send`, and is worth
     * doing the moment a lost review is observed rather than theorised.
     */
    const atSessionEnd = () => {
      if (document.visibilityState === 'hidden') void sync(client, user.id, local, reportSync)
    }

    void run()
    window.addEventListener('online', wake)
    document.addEventListener('visibilitychange', atSessionEnd)

    return () => {
      stopped = true
      clearTimeout(timer)
      window.removeEventListener('online', wake)
      document.removeEventListener('visibilitychange', atSessionEnd)
    }
  }, [user, client, reportSync])
}
