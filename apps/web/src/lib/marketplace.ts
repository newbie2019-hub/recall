import { ApiError, type ApiEnvelope, type ApiErrorBody, type CardTemplate, type NoteType } from '@recall/core'

/**
 * Every call the marketplace makes to the server, and nothing else.
 *
 * One module because the marketplace is the only part of the app that talks to
 * a server about *other people's* data: everywhere else a failed request pauses
 * the sync and the collection carries on (PLAN.md §2.6), but here a failed
 * request means there is nothing to show. Keeping the calls together is what
 * makes that difference reviewable in one file.
 *
 * It does not use `ApiClient` from `@recall/core`: that class has no marketplace
 * methods and its `request` is private, so reaching them would mean editing a
 * shared package mid-phase. Folding these into it later is mechanical.
 *
 * Nothing here renders. Listing text is written by strangers, so it reaches the
 * DOM as React children (escaped), and card HTML reaches only `CardFrame`,
 * which is a sandbox with no `allow-scripts` (README rule 5).
 */

/**
 * Deliberately duplicated from `lib/auth.tsx`, which exports it.
 *
 * Importing it would drag `auth.tsx` — and React — into this module, and
 * `marketplace.test.ts` runs under bare `node --test`, which resolves no `@/`
 * alias and no JSX. The literal is the cheaper of the two costs. Move both to a
 * plain module the day a third file needs it.
 */
const TOKEN_KEY = 'recall.token'

const baseUrl = () =>
  (import.meta.env?.VITE_API_URL ?? 'http://localhost:8000/api/v1').replace(/\/$/, '')

export interface Publisher {
  id: string
  name: string
}

export type ListingStatus = 'draft' | 'in_review' | 'published' | 'removed'
export type Visibility = 'public' | 'unlisted'

export interface ListingVersion {
  version: number
  /** Display only — the integer `version` is identity, because `decks.source_version` is one. */
  semver: string | null
  changelog: string | null
  note_count: number
  size_bytes: number
  checksum: string
  rights_attestation: RightsClaim
  published_at: string | null
}

export interface Listing {
  id: string
  title: string
  description: string | null
  tags: string[]
  visibility: Visibility
  latest_version: number
  /** Real, and the only number on a tile: nobody has rated anything in this phase. */
  install_count: number
  published_at: string | null
  publisher?: Publisher
  /** Loaded on the detail and publish responses, absent while browsing. */
  versions?: ListingVersion[]
  // Publisher- and moderator-only. Absent for everyone else, which is why every
  // one of them is optional rather than nullable.
  /**
   * Which local deck this listing was published from. **Not returned yet** — see
   * the report. Without it the publish screen cannot say "this will be v2", so
   * it degrades to not saying it; publishing is idempotent per deck either way.
   */
  deck_id?: string
  status?: ListingStatus
  open_report_count?: number
  moderation_reason?: string | null
  moderated_at?: string | null
}

/** A note as the publisher's collection holds it. Identity is `source_guid`. */
export interface PayloadNote {
  source_guid: string
  note_type_id: string
  deck_id: string
  fields: Record<string, string>
  /** Space-separated on the wire, as in the notes table. */
  tags: string
}

export interface PayloadDeck {
  id: string
  parent_id: string | null
  name: string
  retention_target: number
  new_per_day: number
}

/** Note types arrive in the server's column spelling, not the core one. */
export interface PayloadNoteType {
  id: string
  name: string
  fields: string[]
  /** Core's own shape — the server stores what the client synced, verbatim. */
  templates: CardTemplate[]
  css: string
  kind: 'standard' | 'cloze' | 'occlusion'
  ord_field: string | null
  sort_field: number
  field_config: unknown[]
  anki_extra: Record<string, unknown>
}

export interface VersionPayload {
  decks: PayloadDeck[]
  note_types: PayloadNoteType[]
  notes: PayloadNote[]
}

export type VersionDownload = ListingVersion & { payload: VersionPayload }

export interface ListingPage {
  listing: Listing
  /** A few notes off the front of the latest version. No note types with them. */
  preview: PayloadNote[]
}

export const RIGHTS = {
  own_work: 'I wrote these cards myself',
  permission: 'I have the rights holder’s permission',
  public_domain: 'The source is in the public domain',
  open_license: 'The source is under an open licence that allows this',
} as const

export type RightsClaim = keyof typeof RIGHTS

export const REPORT_REASONS = {
  copyright: 'Copyright — this is someone else’s material',
  inappropriate: 'Harmful, dangerous or medically false',
  spam: 'Spam or misleading',
  malware: 'Malicious content',
  other: 'Something else',
} as const

export type ReportReason = keyof typeof REPORT_REASONS

export interface ModerationReport {
  id: string
  /** A publisher answering their own takedown files the same shape. */
  kind: 'report' | 'counter_notice'
  reason: ReportReason
  detail: string | null
  created_at: string | null
  reporter: Publisher | null
  listing: Listing
}

export interface Page<T> {
  items: T[]
  next_cursor: number | null
}

// ── transport ─────────────────────────────────────────────────────────────

interface CallOptions {
  method?: string
  json?: unknown
  query?: Record<string, string | number | undefined>
}

/**
 * `globalThis.fetch` is read at call time rather than captured at import: the
 * test stubs it, and capturing would freeze the real one at module load.
 */
async function envelopeOf<T>(path: string, options: CallOptions = {}): Promise<ApiEnvelope<T>> {
  const url = new URL(`${baseUrl()}/${path}`)
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value))
  }

  // Sent when we have one, omitted when we do not: browse, show and download
  // are outside `auth:sanctum`, and a signed-out visitor must get the deck
  // rather than a 401 (PHASES §8).
  const token = globalThis.localStorage?.getItem(TOKEN_KEY)
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (options.json !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`

  let response: Response
  try {
    response = await globalThis.fetch(url.toString(), {
      method: options.method ?? 'GET',
      headers,
      body: options.json === undefined ? undefined : JSON.stringify(options.json),
    })
  } catch (e) {
    throw new ApiError('offline', e instanceof Error ? e.message : String(e))
  }

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    // A gateway or a WAF answers HTML, not our envelope. Losing the status code
    // to a JSON parse error would turn a 503 into a mystery.
  }

  if (!response.ok) {
    const body = payload as ApiErrorBody | null
    throw new ApiError(
      body?.error?.code ?? codeForStatus(response.status),
      body?.error?.message ?? `The marketplace is not answering (${response.status})`,
      response.status,
      body?.error?.meta,
    )
  }
  return payload as ApiEnvelope<T>
}

const call = async <T>(path: string, options: CallOptions = {}): Promise<T> =>
  (await envelopeOf<T>(path, options)).data

function codeForStatus(status: number) {
  if (status === 401) return 'unauthenticated' as const
  if (status === 403) return 'forbidden' as const
  if (status === 404) return 'not_found' as const
  if (status === 422) return 'validation_failed' as const
  if (status === 429) return 'rate_limited' as const
  return 'server_error' as const
}

// ── browse ────────────────────────────────────────────────────────────────

export interface BrowseQuery {
  q?: string
  tag?: string
  cursor?: number | null
}

export async function listListings(query: BrowseQuery = {}): Promise<Page<Listing>> {
  const envelope = await envelopeOf<Listing[]>('marketplace/listings', {
    query: { q: query.q, tag: query.tag, cursor: query.cursor ?? undefined },
  })
  return { items: envelope.data, next_cursor: envelope.next_cursor ?? null }
}

/** The publisher's own shelf, in every state including removed. */
export const myListings = () => call<Listing[]>('marketplace/my-listings')

export async function getListing(id: string): Promise<ListingPage> {
  const envelope = await envelopeOf<Listing>(`marketplace/listings/${encodeURIComponent(id)}`)
  // `preview` rides beside `data` rather than inside it, so it is read off the
  // envelope. A listing published before previews existed simply has none.
  const preview = (envelope as { preview?: PayloadNote[] }).preview ?? []
  return { listing: envelope.data, preview }
}

// ── the version, and why it is fetched whole ──────────────────────────────

const versions = new Map<string, Promise<VersionDownload>>()

/**
 * One immutable version, payload included.
 *
 * Memoised per listing-and-version because two screens want the same bytes for
 * different reasons: the preview needs the note types to render a card with,
 * and cloning needs everything. The listing response carries sample notes but
 * no note types, so a real preview cannot be drawn without this — see the
 * report; `preview: { notes, note_types }` on the listing response would let
 * the preview stop downloading the deck.
 *
 * The cache is per page load. A version is immutable, so it can never go stale;
 * it is dropped on navigation away with the module's own lifetime.
 */
export function getVersion(listingId: string, version: number): Promise<VersionDownload> {
  const key = `${listingId}@${version}`
  let pending = versions.get(key)
  if (!pending) {
    pending = call<VersionDownload>(
      `marketplace/listings/${encodeURIComponent(listingId)}/versions/${version}`,
    ).catch((e: unknown) => {
      // A failed download must not be remembered as the answer.
      versions.delete(key)
      throw e
    })
    versions.set(key, pending)
  }
  return pending
}

/**
 * Tell the server this deck came from this listing.
 *
 * Bookkeeping only — the clone itself is a local write that reaches the server
 * as the cloner's own rows through ordinary sync. Signed out there is nobody to
 * record it against, and the clone still works: `decks.source_listing_id` is
 * what actually drives the update offer.
 */
export const recordInstall = (listingId: string, deckId: string, version: number) =>
  call<{ deck_id: string; version: number }>(
    `marketplace/listings/${encodeURIComponent(listingId)}/installs`,
    { method: 'POST', json: { deck_id: deckId, version } },
  )

// ── publish ───────────────────────────────────────────────────────────────

export interface PublishInput {
  deck_id: string
  title: string
  description: string
  tags: string[]
  visibility: Visibility
  changelog: string
  rights_attestation: RightsClaim
}

export const publishListing = (input: PublishInput) =>
  call<Listing>('marketplace/listings', { method: 'POST', json: input })

/** The publisher's stop button. Versions stay on file and clones are untouched. */
export const unpublishListing = (id: string) =>
  call<Listing>(`marketplace/listings/${encodeURIComponent(id)}`, { method: 'DELETE' })

// ── report & moderate ─────────────────────────────────────────────────────

export const reportListing = (
  id: string,
  input: { reason: ReportReason; detail: string; kind?: 'report' | 'counter_notice' },
) =>
  call<{ id: string; status: string }>(
    `marketplace/listings/${encodeURIComponent(id)}/reports`,
    { method: 'POST', json: input },
  )

/** 403 for anyone who is not a moderator — which is how the page knows. */
export async function openReports(cursor?: number | null): Promise<Page<ModerationReport>> {
  const envelope = await envelopeOf<ModerationReport[]>('moderation/reports', {
    query: { cursor: cursor ?? undefined },
  })
  return { items: envelope.data, next_cursor: envelope.next_cursor ?? null }
}

export const dismissReport = (reportId: string, note: string) =>
  call<{ id: string; status: string }>(
    `moderation/reports/${encodeURIComponent(reportId)}/dismiss`,
    { method: 'POST', json: { note } },
  )

/** Stops distribution. Reaches no collection, including the publisher's own. */
export const takedownListing = (listingId: string, reason: string) =>
  call<Listing>(`moderation/listings/${encodeURIComponent(listingId)}/takedown`, {
    method: 'POST',
    json: { reason },
  })

/** Clears a first-time publisher, or reinstates after a counter-notice. */
export const approveListing = (listingId: string, note: string) =>
  call<Listing>(`moderation/listings/${encodeURIComponent(listingId)}/approve`, {
    method: 'POST',
    json: { note },
  })

/**
 * The server spells note types in its column names; core spells them in its own.
 *
 * The id is namespaced per listing rather than matched against a local type by
 * name: two people's "Basic" are not the same note type, and quietly adopting
 * one into the other would rewrite the fields of cards the person already had.
 * Deterministic, so re-cloning and updating land on the same rows.
 */
export function toNoteType(t: PayloadNoteType, listingId: string): NoteType {
  return {
    id: `market:${listingId}:${t.id}`,
    name: t.name,
    fields: t.fields,
    // A deck override points at a deck in the publisher's collection. Carried
    // across it would send cards to a deck that does not exist here.
    templates: t.templates.map((tmpl) => ({ ...tmpl, deckOverride: null })),
    css: t.css,
    kind: t.kind,
    ordField: t.ord_field ?? undefined,
    sortField: t.sort_field ?? 0,
    fieldConfig: (t.field_config ?? []) as NoteType['fieldConfig'],
    ankiExtra: t.anki_extra ?? {},
  }
}

// ── local decisions ───────────────────────────────────────────────────────

/**
 * The guid a cloned note gets. **Mirrors `App\Services\Marketplace\CloneGuid`
 * exactly** — a difference here orphans every clone, because the merge of v4
 * onto v3 finds its notes by recomputing this.
 *
 * Not the publisher's guid: `notes` is unique on (user_id, guid), so copying it
 * verbatim would make cloning your own listing overwrite the notes you
 * published, and two clones of one deck collide instead of coexisting. Derived
 * from the deck it landed in, so it is stable without a mapping table.
 *
 * Sixteen hex characters, which is what `lower(hex(randomblob(8)))` produces in
 * the schema — indistinguishable from a minted guid everywhere downstream,
 * export included.
 */
export async function cloneGuid(deckId: string, sourceGuid: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${deckId}:${sourceGuid}`)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16)
}

/**
 * Whether to *offer* an update for a deck cloned from this listing.
 *
 * An offer, never an action: once cloned, the deck is the cloner's own and the
 * publisher can never reach into it (PHASES §8). A missing `source_version` is
 * a clone from before versions were recorded — offering there would re-import a
 * deck somebody may have spent months editing, so it stays quiet.
 */
export const updateAvailable = (
  clone: { source_version: number | null } | null,
  listing: { latest_version: number },
): boolean =>
  clone !== null && clone.source_version !== null && clone.source_version < listing.latest_version

/** Sizes are quoted before a download, so a wrong unit is a broken promise. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['kB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/** `Intl` rather than a date library: this is the only relative time in the app. */
export function ago(iso: string | null): string {
  if (!iso) return 'never'
  const days = Math.round((Date.parse(iso) - Date.now()) / 86_400_000)
  if (!Number.isFinite(days)) return 'unknown'
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (Math.abs(days) < 30) return rtf.format(days, 'day')
  if (Math.abs(days) < 365) return rtf.format(Math.round(days / 30), 'month')
  return rtf.format(Math.round(days / 365), 'year')
}
