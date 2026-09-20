import type {
  ApiEnvelope, ApiErrorBody, ApiErrorCode, DeviceIdentity, DeviceSummary,
  Session, SyncPayload, SyncPullResult, SyncPushResult,
} from './types.ts'
import type { OnboardingAnswers } from '../onboarding.ts'

/**
 * The typed client both apps share.
 *
 * It lives in `packages/core` because PLAN.md §2.6 has React Native importing it
 * unchanged. That rules out one thing: nothing here may touch `localStorage`,
 * `AsyncStorage`, OPFS or Keychain. Where the token is kept is a platform
 * decision, so it arrives as an injected `TokenStore`.
 *
 * What it does *not* do is decide policy. A 401 is reported, never acted on —
 * the invariant is that a 401 must never take the collection away (PLAN.md
 * §2.6), and a client that cleared local data on an expired token would break
 * exactly that.
 */

export class ApiError extends Error {
  readonly code: ApiErrorCode
  readonly status: number
  readonly meta?: Record<string, unknown>

  // Fields are declared and assigned rather than promoted in the parameter
  // list: `packages/core` runs under Node's type-stripping loader in tests, and
  // a constructor property is syntax it removes rather than compiles.
  constructor(
    code: ApiErrorCode,
    message: string,
    status: number = 0,
    meta?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.meta = meta
  }

  /** Worth trying again unchanged: the request never landed, or the server was busy. */
  get retryable(): boolean {
    return this.code === 'offline' || this.code === 'rate_limited' || this.status >= 500
  }

  /** The token is gone or stale. The caller queues and shows a banner; it does not wipe. */
  get needsSignIn(): boolean {
    return this.code === 'unauthenticated' || this.code === 'token_expired'
  }
}

/**
 * Where the bearer token lives. SQLite on web, Keychain or Keystore on mobile.
 *
 * Async on purpose: Keychain is, and making the web one pretend to be
 * synchronous would mean two shapes of the same interface.
 */
export interface TokenStore {
  get(): Promise<string | null>
  set(token: string): Promise<void>
  clear(): Promise<void>
}

export interface ApiClientOptions {
  baseUrl: string
  tokens: TokenStore
  /** Injected so tests need no network and RN can supply its own. */
  fetch?: typeof globalThis.fetch
  /** Called once per request that comes back 401, for the sign-in banner. */
  onUnauthenticated?: () => void
  /** Wall clock, injectable so the backoff test does not actually wait. */
  sleep?: (ms: number) => Promise<void>
  maxRetries?: number
}

const DEFAULT_RETRIES = 3

interface RequestOptions {
  method?: string
  body?: unknown
  query?: Record<string, string | number | undefined>
  /** Safe to send again if the reply never arrives. */
  idempotent?: boolean
  auth?: boolean
}

export class ApiClient {
  private readonly options: ApiClientOptions
  private readonly http: typeof globalThis.fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly maxRetries: number

  /**
   * The server's clock minus ours, from the last response.
   *
   * Every response carries `server_time` precisely so this costs no extra
   * request. Phone clocks are wrong often enough that the review log records
   * both times (PLAN.md §2.6); this is how the UI can say so.
   */
  public clockSkewMs = 0

  constructor(options: ApiClientOptions) {
    this.options = options
    this.http = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.maxRetries = options.maxRetries ?? DEFAULT_RETRIES
  }

  // ── auth ────────────────────────────────────────────────────────────────

  async register(input: { name: string; email: string; password: string } & DeviceIdentity): Promise<Session> {
    // Not idempotent and never retried: a retried register that actually
    // succeeded the first time comes back as "email already taken", which reads
    // to the user as though their own account is in the way.
    const session = await this.request<Session>('auth/register', { method: 'POST', body: input, auth: false })
    await this.options.tokens.set(session.token)
    return session
  }

  async login(input: { email: string; password: string } & DeviceIdentity): Promise<Session> {
    const session = await this.request<Session>('auth/login', { method: 'POST', body: input, auth: false })
    await this.options.tokens.set(session.token)
    return session
  }

  /**
   * Sign out this device. The token is dropped locally even if the call fails —
   * the person asked to be signed out, and a network error is not a reason to
   * leave a live token on the device.
   */
  async logout(): Promise<void> {
    try {
      await this.request('auth/logout', { method: 'POST' })
    } finally {
      await this.options.tokens.clear()
    }
  }

  /**
   * Ask for a reset link. Resolves the same way whether or not the address has
   * an account — the server answers identically on purpose, so a caller that
   * branched here would be inventing information it was not given.
   */
  forgotPassword(email: string): Promise<{ sent: boolean }> {
    return this.request<{ sent: boolean }>('auth/forgot-password', {
      method: 'POST',
      body: { email },
      auth: false,
    })
  }

  /**
   * Spend a reset token. Not idempotent and never retried: the token is
   * single-use, so a retry of a request that did land comes back "no longer
   * valid" and reads as though the new password did not take.
   *
   * It issues no session — every device is signed out by a reset, including
   * this one, so the caller sends the person to sign in with the new password.
   */
  resetPassword(input: { token: string; email: string; password: string }): Promise<{ reset: boolean }> {
    return this.request<{ reset: boolean }>('auth/reset-password', {
      method: 'POST',
      body: input,
      auth: false,
    })
  }

  me(): Promise<Session['user']> {
    return this.request<Session['user']>('auth/me', { idempotent: true })
  }

  /** Name, address or avatar. A new address loses its verification server-side. */
  updateProfile(input: { name?: string; email?: string; avatar?: string | null }): Promise<Session['user']> {
    return this.request<Session['user']>('auth/profile', { method: 'PATCH', body: input })
  }

  /**
   * Change the password, proving the current one.
   *
   * Never retried: a retry that succeeded the first time comes back as "that is
   * not your current password", which reads as though the change failed.
   */
  changePassword(input: { current_password: string; password: string }): Promise<{ changed: boolean }> {
    return this.request<{ changed: boolean }>('auth/password', {
      method: 'PUT',
      body: { ...input, password_confirmation: input.password },
    })
  }

  /**
   * Store the onboarding answers.
   *
   * A PUT and an upsert, so a refresh or a back-button in the wizard updates
   * the one row rather than starting a second. Idempotent for the same reason:
   * replaying it cannot do anything the first call did not.
   */
  saveOnboarding(input: OnboardingAnswers): Promise<{ onboarded: boolean }> {
    return this.request<{ onboarded: boolean }>('onboarding', {
      method: 'PUT',
      body: input,
      idempotent: true,
    })
  }

  /**
   * Delete the account and everything the server holds for it.
   *
   * Requires the password again: the token in this browser is enough to study
   * with and not enough to end an account with, and the person asking may not
   * be the person who left the session open.
   *
   * Local rows are untouched — deletion is the server's copy. Whether this
   * device also erases is a separate choice the caller already made.
   */
  async deleteAccount(password: string): Promise<void> {
    try {
      await this.request('account', { method: 'DELETE', body: { password } })
    } finally {
      // The account is gone either way; a token that outlives it is only a
      // way for the next screen to act as though it is still signed in.
      await this.options.tokens.clear()
    }
  }

  devices(): Promise<DeviceSummary[]> {
    return this.request<DeviceSummary[]>('devices', { idempotent: true })
  }

  revokeDevice(deviceId: string): Promise<{ revoked: boolean }> {
    return this.request<{ revoked: boolean }>(`devices/${deviceId}`, { method: 'DELETE' })
  }

  // ── sync ────────────────────────────────────────────────────────────────

  async pull(cursor: number, limit?: number): Promise<SyncPullResult> {
    const envelope = await this.envelope<SyncPullResult['changes']>('sync', {
      idempotent: true,
      query: { cursor, limit },
    })

    return {
      changes: envelope.data,
      next_cursor: envelope.next_cursor ?? null,
      has_more: envelope.has_more ?? false,
      server_time: envelope.server_time,
    }
  }

  /**
   * Push is **safe to retry**, which is the whole reason the keys are
   * client-generated: reviews insert-if-absent and content is last-write-wins,
   * so the same body applied twice is the same result (PLAN.md §2.6).
   */
  push(payload: SyncPayload): Promise<SyncPushResult> {
    return this.request<SyncPushResult>('sync', { method: 'POST', body: payload, idempotent: true })
  }

  // ── transport ───────────────────────────────────────────────────────────

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return (await this.envelope<T>(path, options)).data
  }

  private async envelope<T>(path: string, options: RequestOptions = {}): Promise<ApiEnvelope<T>> {
    let attempt = 0

    for (;;) {
      try {
        const envelope = await this.send<T>(path, options)
        this.clockSkewMs = envelope.server_time - Date.now()
        return envelope
      } catch (e) {
        const error = e instanceof ApiError
          ? e
          // A thrown non-ApiError is the fetch itself failing: no network, DNS,
          // a dropped connection. The request never landed, so it is safe to
          // send again whatever it was.
          : new ApiError('offline', e instanceof Error ? e.message : String(e))

        if (error.needsSignIn) {
          this.options.onUnauthenticated?.()
        }

        if (!options.idempotent || !error.retryable || attempt >= this.maxRetries) {
          throw error
        }

        // Exponential, and jittered so a thousand phones coming back onto wifi
        // at 9am do not retry in lockstep.
        const backoff = 2 ** attempt * 250
        await this.sleep(backoff + Math.random() * backoff)
        attempt++
      }
    }
  }

  private async send<T>(path: string, options: RequestOptions): Promise<ApiEnvelope<T>> {
    const url = new URL(`${this.options.baseUrl.replace(/\/$/, '')}/${path}`)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    const headers: Record<string, string> = { Accept: 'application/json' }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'

    if (options.auth !== false) {
      const token = await this.options.tokens.get()
      if (token) headers.Authorization = `Bearer ${token}`
    }

    const response = await this.http(url.toString(), {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })

    const payload = await this.parse(response)

    if (!response.ok) {
      const body = payload as ApiErrorBody | null
      throw new ApiError(
        body?.error?.code ?? this.codeForStatus(response.status),
        body?.error?.message ?? `Request failed (${response.status})`,
        response.status,
        body?.error?.meta,
      )
    }

    return payload as ApiEnvelope<T>
  }

  private async parse(response: Response): Promise<unknown> {
    try {
      return await response.json()
    } catch {
      // A proxy or a gateway timing out returns HTML, not our envelope. Losing
      // the status code to a JSON parse error would turn a 503 into a mystery.
      return null
    }
  }

  /** When even the error body is not ours — a gateway, a WAF, a 502 page. */
  private codeForStatus(status: number): ApiErrorCode {
    if (status === 401) return 'unauthenticated'
    if (status === 403) return 'forbidden'
    if (status === 404) return 'not_found'
    if (status === 413) return 'payload_too_large'
    if (status === 422) return 'validation_failed'
    if (status === 429) return 'rate_limited'
    return 'server_error'
  }
}
