import * as Y from 'yjs'
import { ApiError } from '@recall/core'
import { decodeUpdate, encodeUpdate } from './doc.ts'
import {
  fetchDocState, pushSnapshot, pushUpdate, type Collaborator,
} from './transport.ts'

/**
 * `echo.ts` is imported lazily, and that is worth a sentence.
 *
 * It pulls in `laravel-echo` and `pusher-js`, which together are the largest
 * dependency added in this phase and are needed by exactly the sessions that
 * open a socket — a small minority, since most decks are private. Loading them
 * on demand keeps them out of the bundle everybody else downloads, and it also
 * keeps a browser-only library out of the way of a test runner that has no DOM.
 */
type EchoApi = typeof import('./echo.ts')

/**
 * One deck's live session: the Y.Doc, the socket, and the queue in between.
 *
 * **The queue is the feature.** PHASES §9's "done when" is two people typing at
 * once *with one of them on a flaky connection*, and everything here exists for
 * the second half of that sentence. A local edit is applied to the document
 * immediately and posted to the server afterwards; if the post fails, the update
 * waits in `pending` and goes out on the next flush. Nothing is lost by being
 * offline, because a Yjs update is valid whenever it eventually arrives —
 * that is the property the whole phase is built on.
 *
 * What this class does *not* do is decide what the document means. It moves
 * bytes and fires callbacks; `materialize.ts` turns the result into rows.
 */

export type Status = 'connecting' | 'live' | 'offline' | 'read-only' | 'error'

export interface Presence {
  id: string
  name: string
  role: Collaborator['role']
}

export interface SessionOptions {
  deckId: string
  /** False for a viewer: the document is applied, nothing is ever sent. */
  canWrite: boolean
  onChange?: (doc: Y.Doc, origin: unknown) => void
  onStatus?: (status: Status, detail?: string) => void
  onPresence?: (members: Presence[]) => void
}

/** Keystrokes are coalesced into one request rather than one per character. */
const DEBOUNCE_MS = 250

/** How long to wait before retrying a flush that failed because we are offline. */
const RETRY_MS = 5_000

export class CollabSession {
  readonly doc = new Y.Doc()

  private readonly options: SessionOptions

  private cursor = 0

  private pending: Uint8Array[] = []

  private flushTimer: ReturnType<typeof setTimeout> | null = null

  private retryTimer: ReturnType<typeof setTimeout> | null = null

  private echoApi: EchoApi | null = null

  private echo: ReturnType<EchoApi['acquireEcho']> = null

  private subscribed = false

  private stopped = false

  private status: Status = 'connecting'

  constructor(options: SessionOptions) {
    this.options = options
    this.doc.on('update', this.onLocalUpdate)
  }

  /**
   * Read the document, then subscribe.
   *
   * In that order, and never the reverse: subscribing first would mean updates
   * arriving while the initial state is still in flight, and a client that
   * applied them *before* the snapshot they build on would hold a document with
   * a hole in it. Yjs tolerates out-of-order updates, but the cursor
   * bookkeeping below does not — and the cursor is what a reconnect resumes
   * from.
   */
  async start(): Promise<void> {
    try {
      await this.pull()
      this.setStatus(this.options.canWrite ? 'live' : 'read-only')
    } catch (e) {
      // Offline is not an error here: the deck opens from the local collection
      // and the session catches up when the network does.
      this.setStatus(
        e instanceof ApiError && e.code === 'offline' ? 'offline' : 'error',
        e instanceof Error ? e.message : String(e),
      )
      this.scheduleRetry()
    }

    void this.subscribe()
  }

  stop(): void {
    this.stopped = true
    this.doc.off('update', this.onLocalUpdate)
    if (this.flushTimer) clearTimeout(this.flushTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.subscribed) {
      this.echo?.leave(`deck.${this.options.deckId}`)
      this.subscribed = false
    }
    if (this.echo) {
      this.echoApi?.releaseEcho()
      this.echo = null
    }
    this.doc.destroy()
  }

  /** Unsent edits. The editor shows this so "saved" is never a guess. */
  get queued(): number {
    return this.pending.length
  }

  // ── local edits ─────────────────────────────────────────────────────────

  /**
   * `origin === this` marks an update this client applied *from the server*, so
   * it is not sent straight back. Every other origin is a local edit.
   */
  private onLocalUpdate = (update: Uint8Array, origin: unknown): void => {
    this.options.onChange?.(this.doc, origin)

    if (origin === this || !this.options.canWrite) return

    this.pending.push(update)
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, DEBOUNCE_MS)
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.stopped) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.reconnect()
    }, RETRY_MS)
  }

  /**
   * Send everything waiting, as **one** update.
   *
   * `Y.mergeUpdates` is what makes a dropped connection cheap: a minute of
   * typing offline is hundreds of updates, and merging them into one before
   * posting means the reconnect costs one request rather than hundreds. The
   * merged update is exactly equivalent — that is a property of the format, not
   * an approximation.
   */
  async flush(): Promise<void> {
    if (this.stopped || !this.pending.length || !this.options.canWrite) return

    const batch = this.pending
    this.pending = []
    const merged = Y.mergeUpdates(batch)

    try {
      const result = await pushUpdate(
        this.options.deckId,
        encodeUpdate(merged),
        this.echoApi?.socketId() ?? null,
      )
      this.cursor = Math.max(this.cursor, result.seq)
      if (this.status !== 'live') this.setStatus('live')
      if (result.should_compact) await this.compact(result.seq)
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'offline' || e.status === undefined)) {
        // Put it back at the front: order does not matter to Yjs, but losing it
        // does, and this is the branch the "flaky connection" case takes.
        this.pending.unshift(merged)
        this.setStatus('offline')
        this.scheduleRetry()
        return
      }

      if (e instanceof ApiError && e.code === 'forbidden') {
        // Demoted or removed mid-session. The edits stay in the local document
        // — they are this person's work — but nothing more is sent.
        this.setStatus('read-only', e.message)
        return
      }

      this.pending.unshift(merged)
      this.setStatus('error', e instanceof Error ? e.message : String(e))
      this.scheduleRetry()
    }
  }

  /**
   * Hand the server a merged document so it can drop the log behind it.
   *
   * The client does this because the server cannot: compacting Yjs updates
   * means running Yjs (PHASES §9). Failure is ignored on purpose — compaction
   * is housekeeping, and a deck that misses one is slower to open, not broken.
   */
  private async compact(upToSeq: number): Promise<void> {
    try {
      await pushSnapshot(
        this.options.deckId,
        encodeUpdate(Y.encodeStateAsUpdate(this.doc)),
        upToSeq,
      )
    } catch {
      // Next client to be asked will try again.
    }
  }

  // ── the server's side ───────────────────────────────────────────────────

  private async pull(): Promise<void> {
    const state = await fetchDocState(this.options.deckId, this.cursor)

    this.doc.transact(() => {
      if (state.snapshot) Y.applyUpdate(this.doc, decodeUpdate(state.snapshot), this)
      for (const update of state.updates) Y.applyUpdate(this.doc, decodeUpdate(update.payload), this)
    }, this)

    this.cursor = Math.max(this.cursor, state.cursor)
  }

  /** Catch up on what was missed, then send what was queued while away. */
  private async reconnect(): Promise<void> {
    if (this.stopped) return
    try {
      await this.pull()
      this.setStatus(this.options.canWrite ? 'live' : 'read-only')
      await this.flush()
    } catch {
      this.setStatus('offline')
      this.scheduleRetry()
    }
  }

  private async subscribe(): Promise<void> {
    // No key configured means no websocket — the session still works over HTTP,
    // which is also the shape the tests run in.
    this.echoApi = await import('./echo.ts').catch(() => null)
    this.echo = this.echoApi?.acquireEcho() ?? null
    if (!this.echo || this.stopped) return
    this.subscribed = true

    this.echo
      .join(`deck.${this.options.deckId}`)
      .here((members: Presence[]) => {
        this.members = members
        this.options.onPresence?.(members)
      })
      .joining((member: Presence) => {
        this.members = [...this.members.filter((m) => m.id !== member.id), member]
        this.options.onPresence?.(this.members)
      })
      .leaving((member: Presence) => {
        this.members = this.members.filter((m) => m.id !== member.id)
        this.options.onPresence?.(this.members)
      })
      .listen('.doc.updated', (event: { seq: number; payload: string }) => {
        // `this` as the origin marks it as "came from the server", which is what
        // stops `onLocalUpdate` posting it straight back and starting a loop.
        Y.applyUpdate(this.doc, decodeUpdate(event.payload), this)
        this.cursor = Math.max(this.cursor, event.seq)
        if (this.status === 'offline') this.setStatus(this.options.canWrite ? 'live' : 'read-only')
      })
  }

  /** The presence roster as the channel last reported it. */
  private members: Presence[] = []

  private setStatus(status: Status, detail?: string): void {
    if (this.status === status) return
    this.status = status
    this.options.onStatus?.(status, detail)
  }
}
