import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { ApiClient, type DeviceSummary, type Session, type TokenStore } from '@recall/core'

/**
 * Who is signed in, and whether the collection is currently reaching a server.
 *
 * **This file used to say signing in was a state and never a gate.** That
 * changed: the app now requires an account, and `components/RequireAuth.tsx` is
 * the wall. What did *not* change is the invariant underneath it (PHASES §5):
 * **a 401 never takes the collection away.** A rejected token or a dead network
 * pauses the queue and nothing else — it must never sign anyone out, never
 * clear local data, and never bounce somebody away from cards already on their
 * device.
 *
 * Which is why the last known user is cached beside the token. On a boot with
 * no network `me()` throws, and a guard reading a null `user` would throw an
 * offline learner back to the sign-in page — turning a gate meant to keep
 * strangers out into one that locks the owner out. The rule the cache buys:
 * **a token that has ever succeeded keeps you in, offline, until you sign out.**
 */
export type SyncStatus =
  /** No account on this device. Reviews accumulate; nothing is waiting to send. */
  | 'local-only'
  /** Signed in and the last exchange with the server succeeded. */
  | 'synced'
  /** Signed in, but the token expired or the network is gone. Rows queue up. */
  | 'paused'

/**
 * The token lives in localStorage and the sync cursor lives in SQLite, which
 * looks like two homes for one thing and is not: the cursor is collection
 * state and travels with the collection, the token is this browser's
 * credential and must die with this browser's storage. Clearing site data has
 * to sign you out; it must not silently resume a sync as somebody else.
 */
export const TOKEN_KEY = 'recall.token'
const DEVICE_KEY = 'recall.device_id'

/**
 * The last user the server confirmed, so a cold offline start still knows who
 * this is. It dies with the token — clearing site data or signing out has to
 * take both, or the app would show a name it can no longer prove.
 */
const USER_KEY = 'recall.user'

function cacheUser(user: Session['user'] | null): void {
  try {
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user))
    else localStorage.removeItem(USER_KEY)
  } catch {
    // A full or blocked storage costs the offline session, never the run.
  }
}

function cachedUser(): Session['user'] | null {
  try {
    const raw = localStorage.getItem(USER_KEY)
    return raw ? (JSON.parse(raw) as Session['user']) : null
  } catch {
    return null
  }
}

const localTokens: TokenStore = {
  get: async () => localStorage.getItem(TOKEN_KEY),
  set: async (token) => localStorage.setItem(TOKEN_KEY, token),
  clear: async () => localStorage.removeItem(TOKEN_KEY),
}

/** Stable per browser, so signing back in resumes a cursor instead of re-pulling. */
function deviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(DEVICE_KEY, id)
  }
  return id
}

function deviceName(): string {
  const ua = navigator.userAgent
  const browser = /Firefox/.test(ua) ? 'Firefox'
    : /Edg\//.test(ua) ? 'Edge'
    : /Chrome/.test(ua) ? 'Chrome'
    : /Safari/.test(ua) ? 'Safari'
    : 'Browser'
  return `${browser} on ${navigator.platform || 'this device'}`
}

interface AuthValue {
  user: Session['user'] | null
  device: DeviceSummary | null
  status: SyncStatus
  /** True until the stored token has been checked, so screens can avoid a flash. */
  loading: boolean
  signIn(email: string, password: string): Promise<void>
  signUp(name: string, email: string, password: string): Promise<void>
  /** Drops the token and keeps every local row. Never destructive. */
  signOut(): Promise<void>
  /** Re-read the account, after something server-side changed it. */
  refreshUser(): Promise<void>
  /** Called by the sync loop after a successful or failed exchange. */
  reportSync(ok: boolean): void
  client: ApiClient
}

const AuthContext = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<Session['user'] | null>(null)
  const [device, setDevice] = useState<DeviceSummary | null>(null)
  const [status, setStatus] = useState<SyncStatus>('local-only')
  const [loading, setLoading] = useState(true)

  // A ref as well as state: the ApiClient is built once, and its
  // onUnauthenticated callback would otherwise close over the first setStatus.
  const statusRef = useRef(setStatus)
  statusRef.current = setStatus

  const client = useMemo(
    () =>
      new ApiClient({
        baseUrl: import.meta.env.VITE_API_URL ?? 'http://localhost:8000/api/v1',
        tokens: localTokens,
        // A 401 pauses the queue. It does not clear the token, does not sign
        // out, and does not navigate — the person keeps studying and finds out
        // from a banner, at a moment of their choosing.
        onUnauthenticated: () => statusRef.current('paused'),
      }),
    [],
  )

  const identity = useMemo(
    () => ({ device_id: deviceId(), device_name: deviceName(), platform: 'web' }),
    [],
  )

  // Resume a session on boot. A failure here is never fatal: no token means
  // local-only, a rejected token means paused, and both keep the collection.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const token = await localTokens.get()
      if (!token) return setLoading(false)
      try {
        const me = await client.me()
        if (!cancelled) {
          setUser(me)
          cacheUser(me)
          setStatus('synced')
        }
      } catch {
        // Offline, or the token expired. Either way the person stays signed in
        // with whatever we last knew about them; the banner says the rest.
        if (!cancelled) {
          setUser(cachedUser())
          setStatus('paused')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client])

  const adopt = useCallback((session: Session) => {
    setUser(session.user)
    cacheUser(session.user)
    setDevice(session.device)
    setStatus('synced')
  }, [])

  const signIn = useCallback(
    async (email: string, password: string) => {
      adopt(await client.login({ email, password, ...identity }))
    },
    [client, identity, adopt],
  )

  const signUp = useCallback(
    async (name: string, email: string, password: string) => {
      adopt(await client.register({ name, email, password, ...identity }))
    },
    [client, identity, adopt],
  )

  const signOut = useCallback(async () => {
    await client.logout()
    cacheUser(null)
    setUser(null)
    setDevice(null)
    setStatus('local-only')
  }, [client])

  // Onboarding flips `onboarded` server-side, and the guard reads it from here.
  const refreshUser = useCallback(async () => {
    const me = await client.me()
    setUser(me)
    cacheUser(me)
    setStatus('synced')
  }, [client])

  const reportSync = useCallback((ok: boolean) => {
    setStatus((s) => (s === 'local-only' ? s : ok ? 'synced' : 'paused'))
  }, [])

  const value = useMemo(
    () => ({ user, device, status, loading, signIn, signUp, signOut, refreshUser, reportSync, client }),
    [user, device, status, loading, signIn, signUp, signOut, refreshUser, reportSync, client],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth outside AuthProvider')
  return value
}
