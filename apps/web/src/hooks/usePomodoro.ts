import { useCallback, useEffect, useRef, useState } from 'react'
import { chime, unlockAudio } from '../lib/audio.ts'
import {
  endSession,
  openSession,
  startSession,
  type PomodoroKind,
  type PomodoroSession,
} from '../db/queries/pomodoro.ts'

/**
 * 25/5, offline, and honest about how much time actually passed.
 *
 * Relative imports with extensions, against the house `@/` style, because the
 * pure half of this file is loaded straight by `node --test` and node resolves
 * no tsconfig alias.
 */

/**
 * Time left, derived from the wall clock.
 *
 * Never from counted ticks. A backgrounded tab throttles timers to roughly once
 * a minute and a suspended one stops them dead, so a counter that decrements
 * per tick freezes: the display would read 18:00 for twenty minutes and then
 * claim a full block was served. `started_at` plus `Date.now()` is right no
 * matter what the tab was doing — the interval below only repaints.
 */
export const remainingMs = (
  s: Pick<PomodoroSession, 'started_at' | 'planned_ms'>,
  now: number,
): number => Math.max(0, s.started_at + s.planned_ms - now)

export const endsAt = (s: Pick<PomodoroSession, 'started_at' | 'planned_ms'>): number =>
  s.started_at + s.planned_ms

/** 0 to 1, for a bar or a ring. */
export const progressOf = (
  s: Pick<PomodoroSession, 'started_at' | 'planned_ms'>,
  now: number,
): number => 1 - remainingMs(s, now) / s.planned_ms

/** Rounded up, so a block that has just started reads 25:00 rather than 24:59. */
export function formatClock(ms: number): string {
  const secs = Math.ceil(ms / 1000)
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
}

/** A chime for a block that ended while the tab was closed is noise, not news. */
const CHIME_GRACE_MS = 10_000

export function usePomodoro(deckId: string | null = null) {
  const [session, setSession] = useState<PomodoroSession | null>(null)
  const [finished, setFinished] = useState<PomodoroKind | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const busy = useRef(false)

  // A running block outlives the page, so the first thing to do is ask the
  // collection whether one is already going.
  useEffect(() => {
    void openSession().then(setSession)
  }, [])

  useEffect(() => {
    if (!session) return
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [session])

  const remaining = session ? remainingMs(session, now) : 0

  useEffect(() => {
    if (!session || remaining > 0 || busy.current) return
    busy.current = true
    const planned = endsAt(session)
    // Closed at its planned end, not at the moment this tab noticed. The row is
    // a record of the block that was served.
    void endSession(session.id, planned).finally(() => {
      busy.current = false
      setSession(null)
      setFinished(session.kind)
      if (Date.now() - planned < CHIME_GRACE_MS) chime()
    })
  }, [session, remaining])

  const start = useCallback(
    async (kind: PomodoroKind) => {
      // This runs inside the click, which is the only moment the browser will
      // let the audio context start. Without it the end-of-block chime is mute.
      unlockAudio()
      setFinished(null)
      setSession(await startSession(kind, deckId))
      setNow(Date.now())
    },
    [deckId],
  )

  /** Stop early. The row keeps `planned_ms`, so a short block reads as short. */
  const stop = useCallback(async () => {
    if (!session) return
    await endSession(session.id, Date.now())
    setSession(null)
    setFinished(null)
  }, [session])

  return {
    session,
    remaining,
    progress: session ? progressOf(session, now) : 0,
    /** The kind that just ended, until the next block starts or it is dismissed. */
    finished,
    dismiss: useCallback(() => setFinished(null), []),
    start,
    stop,
  }
}
