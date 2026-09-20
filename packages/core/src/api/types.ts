/**
 * The wire contract, shared by the web app and (later) React Native.
 *
 * These names mirror `app/Enums` and `app/Support/ApiResponse.php` on the
 * server. They are duplicated rather than generated because the two sides ship
 * independently: an installed phone keeps talking v1 long after the web app has
 * moved on, so the client's idea of v1 has to be able to stay still while the
 * server's changes (PLAN.md §2.6).
 */

/**
 * Stable error codes. The *message* is for a human and may be reworded in any
 * release; these may not, ever, because an old build branches on them.
 */
export type ApiErrorCode =
  | 'invalid_credentials'
  | 'unauthenticated'
  | 'token_expired'
  | 'forbidden'
  | 'not_found'
  | 'validation_failed'
  | 'rate_limited'
  | 'payload_too_large'
  | 'server_error'
  /** Phase 10. Four different things to say, so four codes. */
  | 'ai_unavailable'
  | 'ai_consent_required'
  | 'ai_quota_exceeded'
  | 'ai_refused'
  | 'ai_upstream'
  /** Not from the server: no network, DNS failure, the request never landed. */
  | 'offline'

export interface ApiEnvelope<T> {
  data: T
  server_time: number
  next_cursor?: number | null
  has_more?: boolean
}

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string; meta?: Record<string, unknown> }
  server_time?: number
}

export interface Session {
  user: {
    id: string
    name: string
    email: string
    email_verified: boolean
    /**
     * Whether to *draw* the moderation queue in the app chrome, never whether
     * the call is allowed — that is the server's policy and stays there.
     */
    is_moderator: boolean
    /**
     * Whether `/welcome` has been finished. The route guard reads this, so it
     * travels on the session rather than costing a second request on boot.
     */
    onboarded: boolean
    /** A key into the client's own drawn set, or null for initials. */
    avatar: string | null
  }
  device: DeviceSummary
  token: string
  expires_at: string | null
}

export interface DeviceSummary {
  id: string
  name: string
  platform: string | null
  cursor: number
  last_seen_at: string | null
  current: boolean
}

/** What this device calls itself. `id` is kept so a re-sign-in keeps its cursor. */
export interface DeviceIdentity {
  device_name: string
  device_id?: string
  platform?: string
}

// ── sync ──────────────────────────────────────────────────────────────────

export const SYNC_RESOURCES = [
  'decks', 'note_types', 'notes', 'card_states', 'reviews', 'media',
] as const

export type SyncResourceName = (typeof SYNC_RESOURCES)[number]

/** A row on its way up. Keys and timestamps are the client's. */
export type SyncRow = Record<string, unknown>

export type SyncPayload = Partial<Record<SyncResourceName, SyncRow[]>>

/** A row on its way down, carrying where it sits in the revision order. */
export type SyncChange = SyncRow & {
  revision: number
  /** Absent on reviews, which are append-only and never deleted. */
  deleted?: boolean
}

export interface SyncPullResult {
  changes: Record<SyncResourceName, SyncChange[]>
  next_cursor: number | null
  has_more: boolean
  /** The server's clock, for detecting this device's skew without a round trip. */
  server_time: number
}

export interface SyncPushResult {
  /** Only resources that actually changed appear here. */
  applied: Partial<Record<SyncResourceName, number>>
  /** Rows the server already had, or that lost last-write-wins. */
  skipped: Partial<Record<SyncResourceName, string[]>>
}


/**
 * What this account has spent on AI this period.
 *
 * Every figure is derived from the append-only `ai_usage` log rather than from
 * a counter, so the total in Settings and the total on the Anthropic invoice
 * are the same query over the same rows (AI.md §3.2).
 */
export interface AiUsage {
  plan: string
  period_start: string
  period_end: string
  spent_micros: number
  limit_micros: number
  remaining_micros: number
  by_feature: Record<string, { calls: number; micros: number }>
  /** Whether this account has turned the subsystem on. Nothing is sent until it has. */
  consented: boolean
  /** Whether the server has an API key at all. */
  available: boolean
}

export interface AiExplanation {
  explanation: string
  confusable_with: string
}
