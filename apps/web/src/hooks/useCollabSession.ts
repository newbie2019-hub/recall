import { useEffect, useRef, useState } from 'react'
import type * as Y from 'yjs'
import { collectionReady } from '@/db/boot'
import { useAuth } from '@/lib/auth'
import { CollabSession, type Presence, type Status } from '@/lib/collab/provider'
import { materialize, seedFromCollection } from '@/lib/collab/materialize'
import { fetchRoster, type Collaborator } from '@/lib/collab/transport'

export interface CollabState {
  /** Null when the deck is not shared, or nobody is signed in. */
  doc: Y.Doc | null
  session: CollabSession | null
  status: Status | 'idle'
  role: Collaborator['role'] | null
  members: Presence[]
  /** Bumped on every applied change, so screens can re-read without deep compare. */
  revision: number
}

const IDLE: CollabState = {
  doc: null, session: null, status: 'idle', role: null, members: [], revision: 0,
}

/**
 * Open a live session for a deck, if it is shared and this person may see it.
 *
 * **It stays idle for the common case.** Most decks are private, most sessions
 * never touch one, and a websocket per deck opened on the chance somebody
 * shares it later is a connection bought for nothing. The roster call decides:
 * a 403 or a solo roster means no session, and the editor carries on writing
 * rows directly as it always has.
 *
 * A viewer gets a session with `canWrite: false` — they see edits land live and
 * send nothing. That is the difference between viewer and editor made visible,
 * rather than a disabled button.
 */
export function useCollabSession(deckId: string | undefined): CollabState {
  const { user } = useAuth()
  const [state, setState] = useState<CollabState>(IDLE)
  const sessionRef = useRef<CollabSession | null>(null)

  useEffect(() => {
    if (!deckId || !user) {
      setState(IDLE)
      return
    }

    let cancelled = false
    let session: CollabSession | null = null

    void (async () => {
      await collectionReady

      // A deck nobody else is on needs no session. `forbidden` lands here too,
      // for a deck id that is not this account's at all.
      //
      // ponytail: one roster request per deck opened while signed in, to answer
      // a question that is "no" for almost every deck. A `shared` flag on the
      // local `decks` row, written when an invitation is accepted and cleared
      // when the last collaborator leaves, removes the call — worth doing when
      // somebody notices it in the network tab, not before.
      const roster = await fetchRoster(deckId).catch(() => null)
      if (cancelled || !roster || roster.collaborators.length < 2) return

      const canWrite = roster.role === 'owner' || roster.role === 'admin' || roster.role === 'editor'

      session = new CollabSession({
        deckId,
        canWrite,
        onStatus: (status) => !cancelled && setState((s) => ({ ...s, status })),
        onPresence: (members) => !cancelled && setState((s) => ({ ...s, members })),
        onChange: () => {
          if (cancelled || !session) return
          // Every applied change is written into the collection, so study,
          // search and the browser keep reading ordinary SQL (PHASES §9).
          void materialize(session.doc, deckId).then((written) => {
            if (!cancelled && written) setState((s) => ({ ...s, revision: s.revision + 1 }))
          })
        },
      })

      sessionRef.current = session
      setState({
        doc: session.doc,
        session,
        status: 'connecting',
        role: roster.role,
        members: [],
        revision: 0,
      })

      await session.start()
      if (cancelled) return

      // A deck shared for the first time has an empty document and a full
      // collection; this is the one moment the rows seed the document rather
      // than the other way round.
      if (canWrite) {
        const seeded = await seedFromCollection(session.doc, deckId)
        if (seeded) await session.flush()
      }
    })()

    return () => {
      cancelled = true
      session?.stop()
      sessionRef.current = null
    }
  }, [deckId, user])

  return state
}
