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
  /**
   * Opaque. An integer where it is an offset or a revision, a string where the
   * list is keyset-paged. Hand it back as received; never do arithmetic on it.
   */
  next_cursor?: number | string | null
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
export interface AiTokens {
  input: number
  cache_write: number
  cache_read: number
  output: number
}

export interface AiUsage {
  plan: string
  period_start: string
  period_end: string
  spent_micros: number
  limit_micros: number
  /**
   * Promised to a document still being processed, and already deducted from
   * `remaining_micros`. Shown rather than silently subtracted: an allowance
   * that reads smaller than the calls beneath it is a number nobody can check.
   */
  reserved_micros: number
  remaining_micros: number
  /**
   * What was actually sent and received, as Anthropic counts it.
   *
   * Kept beside the dollars rather than instead of them, because the two
   * answer different questions: a price change reprices the whole history, and
   * the token count is the part of the bill that does not move.
   */
  tokens: AiTokens
  by_feature: Record<string, { calls: number; micros: number; tokens: AiTokens }>
  /** Whether this account has turned the subsystem on. Nothing is sent until it has. */
  consented: boolean
  /** Whether the server has an API key at all. */
  available: boolean
}

export interface AiExplanation {
  explanation: string
  confusable_with: string
}

/**
 * What the grader thought of one card.
 *
 * The tiers are the Memory Machines benchmark's: 0 is off-target, **1 is the
 * one that matters** — structurally broken but plausible-looking, the card that
 * quietly wastes months of review — 2 is usable with a fixable weakness, and 3
 * is fine.
 */
export interface AiVerdict {
  id: string
  tier: 0 | 1 | 2 | 3
  dimension: 'lacks_context' | 'multiple_answers' | 'shallow' | 'wordy' | 'too_narrow' | 'ok'
  reason: string
}

/** How many cards one grading call carries. Mirrors `GradeService::BATCH`. */
export const GRADE_BATCH = 20

/** A generation run. Shaped like an import job, because it is the same wait. */
export interface AiJob {
  id: string
  source_name: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'partial'
  stage: string
  done: number
  total: number
  estimated_micros: number
  error: string | null
  candidates: number
}

/**
 * A suggested card, already past the grader.
 *
 * Tiers 0 and 1 never reach the client: they were dropped before this table was
 * written. What arrives is tier 2 (usable, with a named weakness) and tier 3
 * (fine) — and the weakness is shown, because a reviewer deciding in two
 * seconds deserves to know which ones to look at hardest.
 */
export interface AiCandidate {
  id: string
  note_type: string
  fields: Record<string, string>
  tags: string[]
  tier: 2 | 3
  dimension: string
  reason: string
  source_excerpt: string | null
}

/**
 * A suggested rewrite of a card being written.
 *
 * `fields` holds **only what would change** — a field that came back identical
 * is not a suggestion, and an accept button on a box nothing happened to is a
 * lie about the diff. Plain text, never markup: it is stripped on the way out
 * of the server and inserted as text here, because README rule 5 gives card
 * HTML a sandboxed frame precisely because it is untrusted.
 *
 * Nothing is applied until the person applies it, one field at a time.
 */
export interface AiRewrite {
  fields: Record<string, string>
  /** What changed and why — or why nothing did. */
  note: string
}

// ── friends, presence and the weekly board (Phase 14d) ────────────────────

/**
 * Somebody you study alongside.
 *
 * `status` is from **your** side of the row, which is the only side a client
 * ever needs: `pending_out` is a request you sent, `pending_in` is one waiting
 * on you. The server decides which by looking at who asked, so a client cannot
 * accept its own invitation by relabelling it.
 */
export interface Friend {
  /** The friendship row, which is what accept / decline / remove address. */
  id: string
  user: { id: string; name: string; avatar: string | null }
  status: 'accepted' | 'pending_in' | 'pending_out'
  /**
   * Seen within the last few minutes. Derived from `last_seen_at`, which any
   * authenticated request touches — a heartbeat websocket would be a second
   * presence system to keep honest for a green dot.
   */
  online: boolean
  last_seen_at: string | null
}

/**
 * One row of the weekly board.
 *
 * ⚠️ This is the one place in the app that compares you to another person.
 * Everything else — retention, streaks, the goal meter — is measured against
 * your own past on purpose, because peer comparison helps high achievers and
 * demotivates everyone else. It is opt-in, friends-only, and the UI must keep
 * `you` findable without ceremony: no podium, no medals, no "last place".
 */
export interface FriendLeaderRow {
  user_id: string
  name: string
  avatar: string | null
  reviews: number
  /** Minutes with a card actually on screen, from the synced `duration_ms`. */
  minutes: number
  /** So the row can be marked without the client matching ids itself. */
  is_you: boolean
}

export interface FriendLeaderboard {
  /** ISO. The board is a *window*, never all-time — all-time is unwinnable. */
  period_start: string
  period_end: string
  rows: FriendLeaderRow[]
}

/** Two paragraphs over figures the model was given, never ones it computed. */
export interface AiBriefing {
  headline: string
  assessment: string
  advice: string
}
