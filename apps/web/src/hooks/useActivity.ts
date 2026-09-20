import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router'
import { db } from '@/db/client'
import { collectionReady } from '@/db/boot'

/**
 * Time spent in the app that is not reviewing.
 *
 * Reviewing is already measured, card by card, in `reviews.duration_ms`. What
 * nothing records is the rest of it — browsing, editing, reading the
 * dashboard — and the gap between the two is a number worth showing: "40
 * minutes in the app, 12 of them reviewing" is a more honest account of an
 * evening than either half alone.
 *
 * **A heartbeat, not a start/stop pair.** There is no reliable event for "this
 * tab went away": a crash, a force-quit, a closed laptop and a dead battery all
 * skip `beforeunload`. Writing `last_seen` every {@link BEAT_MS} costs at most
 * that much accuracy at the end of a session and can never leave one open
 * forever, which a missing `ended_at` would.
 *
 * A gap longer than {@link SESSION_GAP_MS} starts a new row. Thirty minutes is
 * the de-facto session boundary in the educational-data-mining literature
 * rather than a number picked here — worth keeping, because changing it changes
 * every session-shaped statistic downstream.
 *
 * The beat only fires while the document is visible, so a tab left open in the
 * background overnight contributes nothing.
 *
 * Local only, deliberately: this is a number for the person's own dashboard and
 * it is not in the sync payload.
 */

export const BEAT_MS = 30_000
export const SESSION_GAP_MS = 30 * 60_000

export function useActivity(): void {
  const location = useLocation()
  const session = useRef<{ id: string; lastSeen: number } | null>(null)
  // Read inside the interval without making the interval depend on it — the
  // route changes far more often than the beat, and restarting the timer on
  // every navigation is how a heartbeat quietly stops beating.
  const route = useRef(location.pathname)
  route.current = location.pathname

  useEffect(() => {
    let cancelled = false

    async function beat() {
      if (cancelled || globalThis.document?.visibilityState === 'hidden') return
      await collectionReady
      if (cancelled) return

      const now = Date.now()
      const current = session.current
      const section = route.current.split('/')[1] || 'decks'

      // A gap means the person was somewhere else entirely. Their last session
      // keeps the `last_seen` it had, which is what stops a closed laptop being
      // counted as eight hours of study.
      if (!current || now - current.lastSeen > SESSION_GAP_MS) {
        const row = { id: crypto.randomUUID(), lastSeen: now }
        session.current = row
        await db.run(
          'INSERT INTO app_sessions (id, started_at, last_seen, route) VALUES (?, ?, ?, ?)',
          [row.id, now, now, section],
        )
        return
      }

      current.lastSeen = now
      await db.run('UPDATE app_sessions SET last_seen = ?, route = ? WHERE id = ?', [
        now, section, current.id,
      ])
    }

    void beat()
    const timer = setInterval(() => void beat(), BEAT_MS)
    // Coming back to the tab should land a beat immediately rather than up to
    // half a minute later, or a short visit records nothing at all.
    const onVisible = () => void beat()
    globalThis.document?.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      clearInterval(timer)
      globalThis.document?.removeEventListener('visibilitychange', onVisible)
    }
  }, [])
}
