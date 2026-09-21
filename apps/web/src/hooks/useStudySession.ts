import { useEffect, useState } from 'react'
import { useAuth } from '@/lib/auth'
import {
  StudySession, type SessionMember, type SessionStatus,
} from '@/lib/collab/session'

export interface StudySessionState {
  /** Null unless a room was actually asked for and can actually be entered. */
  session: StudySession | null
  status: SessionStatus
  /** In join order. Never sorted by count — see `session.ts`. */
  members: SessionMember[]
  total: number
}

const IDLE: StudySessionState = { session: null, status: 'idle', members: [], total: 0 }

/**
 * Join the room for a deck, if a room was asked for.
 *
 * **Idle is the normal answer.** Studying alone is what almost every session
 * is, and this hook is on the one screen in the app that has to stay quiet, so
 * it opens nothing at all unless `?session=1` put it here. That is the
 * difference from `useCollabSession`, which asks the server whether a deck is
 * shared: a study session is not a property of the deck, it is a thing somebody
 * chose to do, so the URL decides and no request is made to find out.
 *
 * It also stays idle when there is no deck — the channel is `deck.{id}` and
 * `/study` across the whole collection has no id to name — and when Reverb is
 * not configured, which `StudySession.subscribe()` discovers for itself by
 * getting a null out of `acquireEcho()`.
 */
export function useStudySession(
  deckId: string | null | undefined,
  enabled: boolean,
): StudySessionState {
  const { user } = useAuth()
  const [state, setState] = useState<StudySessionState>(IDLE)

  useEffect(() => {
    if (!enabled || !deckId || !user) {
      setState(IDLE)
      return
    }

    let cancelled = false
    const session = new StudySession({
      deckId,
      me: { id: user.id, name: user.name },
      onStatus: (status) => !cancelled && setState((s) => ({ ...s, status })),
      onChange: (members, total) => !cancelled && setState((s) => ({ ...s, members, total })),
    })

    setState({ ...IDLE, session })
    session.start()

    return () => {
      cancelled = true
      session.stop()
    }
  }, [deckId, enabled, user])

  return state
}
