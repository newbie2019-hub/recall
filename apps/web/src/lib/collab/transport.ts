import { ApiError, type ApiEnvelope } from '@recall/core'

/**
 * The collaboration endpoints, and nothing else.
 *
 * Split from `provider.ts` so the provider's merge-and-retry logic can be read
 * — and tested — without a network in the way. Same shape as
 * `lib/marketplace.ts`, and for the same reason: these calls are about a
 * *shared* document, where a failure means something different from a failed
 * sync of your own rows. A sync failure pauses and the collection carries on; a
 * failure here means somebody else's edits are not arriving, and the screen has
 * to say so.
 */

const TOKEN_KEY = 'recall.token'

export const collabBaseUrl = () =>
  (import.meta.env?.VITE_API_URL ?? 'http://localhost:8000/api/v1').replace(/\/$/, '')

export interface DocState {
  snapshot: string | null
  snapshot_seq: number
  updates: { seq: number; payload: string }[]
  cursor: number
  should_compact: boolean
}

export interface Collaborator {
  id: string | null
  user_id: string | null
  name: string | null
  email: string | null
  role: 'owner' | 'admin' | 'editor' | 'viewer'
  accepted_at: string | null
}

export interface Roster {
  role: Collaborator['role'] | null
  collaborators: Collaborator[]
}

export interface Invitation {
  id: string
  deck_id: string
  deck_name: string | null
  role: Collaborator['role']
  invited_by: string | null
  created_at: string | null
}

export interface SharedDeck {
  deck_id: string
  deck_name: string | null
  owner: string | null
  role: Collaborator['role']
}

interface CallOptions {
  method?: string
  json?: unknown
  query?: Record<string, string | number | undefined>
  /** Reverb's socket id, so the server can skip echoing an update to its author. */
  socketId?: string | null
}

async function call<T>(path: string, options: CallOptions = {}): Promise<T> {
  const url = new URL(`${collabBaseUrl()}/${path}`)
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value))
  }

  const token = globalThis.localStorage?.getItem(TOKEN_KEY)
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (options.json !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  if (options.socketId) headers['X-Socket-ID'] = options.socketId

  let response: Response
  try {
    response = await globalThis.fetch(url.toString(), {
      method: options.method ?? 'GET',
      headers,
      body: options.json === undefined ? undefined : JSON.stringify(options.json),
    })
  } catch (e) {
    // The one error the provider treats as "try again later" rather than
    // "stop": an offline client queues its edits and flushes on reconnect,
    // which is what a CRDT is for.
    throw new ApiError('offline', e instanceof Error ? e.message : String(e))
  }

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    // A gateway answering HTML must not turn into a JSON parse error.
  }

  if (!response.ok) {
    const body = payload as { error?: { code?: string; message?: string } } | null
    throw new ApiError(
      (body?.error?.code as ApiError['code']) ?? statusCode(response.status),
      body?.error?.message ?? `Collaboration is not answering (${response.status})`,
      response.status,
    )
  }

  return (payload as ApiEnvelope<T>).data
}

function statusCode(status: number) {
  if (status === 401) return 'unauthenticated' as const
  if (status === 403) return 'forbidden' as const
  if (status === 404) return 'not_found' as const
  if (status === 422) return 'validation_failed' as const
  if (status === 429) return 'rate_limited' as const
  return 'server_error' as const
}

// ── the document ──────────────────────────────────────────────────────────

export const fetchDocState = (deckId: string, since = 0) =>
  call<DocState>(`decks/${encodeURIComponent(deckId)}/doc`, {
    query: { since: since || undefined },
  })

export const pushUpdate = (deckId: string, payload: string, socketId: string | null) =>
  call<{ seq: number; should_compact: boolean }>(
    `decks/${encodeURIComponent(deckId)}/doc/updates`,
    { method: 'POST', json: { payload }, socketId },
  )

export const pushSnapshot = (deckId: string, payload: string, upToSeq: number) =>
  call<{ up_to_seq: number }>(`decks/${encodeURIComponent(deckId)}/doc/snapshot`, {
    method: 'POST',
    json: { payload, up_to_seq: upToSeq },
  })

// ── who is on the deck ────────────────────────────────────────────────────

export const fetchRoster = (deckId: string) =>
  call<Roster>(`decks/${encodeURIComponent(deckId)}/collaborators`)

export const inviteCollaborator = (deckId: string, email: string, role: string) =>
  call<{ collaborators: Collaborator[] }>(`decks/${encodeURIComponent(deckId)}/collaborators`, {
    method: 'POST',
    json: { email, role },
  })

export const setCollaboratorRole = (deckId: string, collaboratorId: string, role: string) =>
  call<{ collaborators: Collaborator[] }>(
    `decks/${encodeURIComponent(deckId)}/collaborators/${encodeURIComponent(collaboratorId)}`,
    { method: 'PATCH', json: { role } },
  )

export const removeCollaborator = (deckId: string, collaboratorId: string) =>
  call<{ collaborators: Collaborator[] }>(
    `decks/${encodeURIComponent(deckId)}/collaborators/${encodeURIComponent(collaboratorId)}`,
    { method: 'DELETE' },
  )

export const fetchInvitations = () =>
  call<{ pending: Invitation[]; shared_with_me: SharedDeck[] }>('collaborations')

export const acceptInvitation = (id: string) =>
  call<{ deck_id: string; role: string }>(`collaborations/${encodeURIComponent(id)}/accept`, {
    method: 'POST',
  })

export const declineInvitation = (id: string) =>
  call<{ declined: boolean }>(`collaborations/${encodeURIComponent(id)}`, { method: 'DELETE' })
