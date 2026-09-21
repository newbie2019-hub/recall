/**
 * `echo.ts` is imported lazily for the same reason `provider.ts` does it: it
 * pulls in `laravel-echo` and `pusher-js`, and the study screen must not make
 * everybody who studies alone download a websocket client. The dynamic import
 * also keeps a browser-only library out of a test runner with no DOM.
 */
type EchoApi = typeof import('./echo.ts')
type EchoInstance = NonNullable<ReturnType<EchoApi['acquireEcho']>>
type DeckChannel = ReturnType<EchoInstance['join']>

/**
 * Together mode: everybody in the same deck at the same time, each from their
 * own queue.
 *
 * **This class shares attention and never a review log.** It does not touch the
 * `Y.Doc` — that is content, and this is attention — and it writes nothing to
 * anybody's collection. What crosses the wire is a count somebody's own device
 * reported about itself; no scheduling, no card, no review. That is the whole
 * reason the feature needs no table, no controller and no migration: it is the
 * one kind of state the server is better off never seeing.
 *
 * It rides on the presence channel Phase 9 already authorizes (`deck.{id}` in
 * `routes/channels.php`) using client events, which `config/reverb.php` already
 * admits from members. So membership is decided by the same rule the REST
 * endpoints use, and nothing new is authorized here.
 *
 * **The shared quantity is a total, not a ranking.** `roster()` sorts by join
 * time and never by score; nothing in this file knows how to compare two people.
 * That is not an oversight to be fixed later — it is what makes a self-reported
 * count acceptable, because there is nothing to win by inflating it.
 */

export type MemberState = 'studying' | 'caught-up' | 'idle'

/** What one person's device says about itself. Everything here is self-reported. */
export interface SessionBeat {
  id: string
  name: string
  /** Cards answered since joining this session. */
  answered: number
  /** When they joined, so the strip can order by arrival and never by score. */
  since: number
  /**
   * `idle` is missing on purpose: a device cannot usefully report its own
   * silence, so the receiver derives it from how long ago the count last moved.
   * `caught-up` it *can* report, and must — see `caughtUp()`.
   */
  state: 'studying' | 'caught-up'
}

export interface SessionMember extends Omit<SessionBeat, 'state'> {
  state: MemberState
}

export type SessionStatus = 'idle' | 'live'

export interface StudySessionOptions {
  deckId: string
  me: { id: string; name: string }
  /** Fires only when the numbers actually changed — see `publish()`. */
  onChange?: (members: SessionMember[], total: number) => void
  onStatus?: (status: SessionStatus) => void
  /**
   * A test seam, and the only one: given a `send`, the session never opens a
   * socket, so `session.test.ts` drives the whole merge/expire/dedupe path
   * against a fake transport with no browser.
   */
  send?: (beat: SessionBeat) => void
  /** The other test seam. Everything here is a clock comparison. */
  now?: () => number
}

/** Answers are coalesced into one beat, the way provider.ts coalesces keystrokes. */
const DEBOUNCE_MS = 250

/**
 * A whisper is not stored, so somebody who joins ten seconds in sees an empty
 * room until everyone beats again. The heartbeat is what makes a late joiner
 * converge, and one beat is an acceptable wait for a number that is decorative.
 */
const HEARTBEAT_MS = 10_000

/** No beat for this long and you are gone — a crashed tab never says goodbye. */
const EXPIRE_MS = 30_000

/**
 * Still here, still counting nothing. Derived by the receiver, not claimed.
 *
 * Longer than `EXPIRE_MS` on purpose, and the two only make sense together:
 * the heartbeat keeps a live member from expiring while they think, so what
 * separates "reading a hard card" from "closed the laptop" is that the first
 * one is still beating. A tab that dies goes at thirty seconds; a person who
 * has answered nothing for two minutes goes quiet on the strip and stays.
 */
const IDLE_MS = 120_000

interface Heard {
  beat: SessionBeat
  /**
   * Local receipt time, never the `since` on the wire. Two devices disagree
   * about the clock by however much they disagree, and expiry measured against
   * somebody else's idea of now would drop a live member or keep a dead one.
   */
  at: number
  /** When `answered` last moved, which is what idleness is actually about. */
  changedAt: number
}

/**
 * Whether a room can be entered at all.
 *
 * Deliberately a copy of `collabConfigured()` rather than an import of it:
 * importing `echo.ts` from a module the deck screen loads eagerly would drag
 * `laravel-echo` and `pusher-js` into the bundle every visitor downloads, which
 * is the exact cost the lazy import above exists to avoid.
 */
export const sessionsAvailable = (): boolean => Boolean(import.meta.env?.VITE_REVERB_APP_KEY)

export class StudySession {
  private readonly options: StudySessionOptions

  private readonly heard = new Map<string, Heard>()

  private mine: SessionBeat

  private echoApi: EchoApi | null = null

  private echo: EchoInstance | null = null

  private channel: DeckChannel | null = null

  private flushTimer: ReturnType<typeof setTimeout> | null = null

  private heartbeat: ReturnType<typeof setInterval> | null = null

  private stopped = false

  private status: SessionStatus = 'idle'

  /** The last roster the callback was told about, as a string, to skip repeats. */
  private signature = ''

  constructor(options: StudySessionOptions) {
    this.options = options
    this.mine = {
      id: options.me.id,
      name: options.me.name,
      answered: 0,
      since: this.now(),
      state: 'studying',
    }
  }

  start(): void {
    this.heartbeat = setInterval(() => this.beat(), HEARTBEAT_MS)
    this.beat()
    void this.subscribe()
  }

  stop(): void {
    this.stopped = true
    if (this.flushTimer) clearTimeout(this.flushTimer)
    if (this.heartbeat) clearInterval(this.heartbeat)

    /**
     * Unbind this listener, then let go of the channel.
     *
     * Echo caches a presence channel by name and hands the same object to every
     * caller, so a co-editing session on this deck in the same tab is holding
     * *this* object. Both sides now retain and release it through `echo.ts`,
     * and whoever is last actually leaves — the unbind is still ours to do,
     * because a channel that survives must not keep calling back into a session
     * that has stopped.
     */
    this.channel?.stopListeningForWhisper('session', this.onWhisper)
    this.channel = null
    if (this.echo) this.echoApi?.releaseChannel(`deck.${this.options.deckId}`)

    if (this.echo) {
      this.echoApi?.releaseEcho()
      this.echo = null
    }
    this.setStatus('idle')
  }

  // ── what this person is doing ───────────────────────────────────────────

  /** A review landed. Called *after* `answerCard` resolves, never before. */
  answered(): void {
    this.mine = { ...this.mine, answered: this.mine.answered + 1, state: 'studying' }
    this.beat()
  }

  /**
   * Nothing left due.
   *
   * Reported rather than inferred from silence, because the two look identical
   * from outside and mean opposite things: somebody who finished the deck has
   * done the thing, and labelling them `idle` reads as a rebuke to the one
   * person in the room who is ahead.
   */
  caughtUp(): void {
    if (this.mine.state === 'caught-up') return
    this.mine = { ...this.mine, state: 'caught-up' }
    this.beat()
  }

  // ── what everybody else is doing ────────────────────────────────────────

  /**
   * A beat off the wire.
   *
   * `senderId` is Reverb's word, not the sender's: `ClientEvent.php` rebuilds
   * every rebroadcast client event and stamps the authenticated `user_id` on
   * it, which pusher-js hands to the listener as metadata. So identity is
   * server-checked even though the count beside it is not — and the count is
   * the only part that can be fabricated, which is why §4 of the plan is
   * willing to live with it while nothing ranks.
   */
  receive(raw: unknown, senderId?: unknown): void {
    const beat = asBeat(raw)
    if (!beat) return
    const id = senderId === undefined || senderId === null ? beat.id : String(senderId)
    this.merge(beat, id)
  }

  /** Everyone still beating, earliest joiner first. Never sorted by score. */
  roster(now: number = this.now()): SessionMember[] {
    return [...this.heard.values()]
      .filter((h) => now - h.at < EXPIRE_MS)
      .sort((a, b) => a.beat.since - b.beat.since || a.beat.id.localeCompare(b.beat.id))
      .map((h) => ({
        ...h.beat,
        state:
          h.beat.state === 'caught-up'
            ? 'caught-up'
            : now - h.changedAt > IDLE_MS
              ? 'idle'
              : 'studying',
      }))
  }

  /** What the room has answered between them. */
  total(now: number = this.now()): number {
    return this.roster(now).reduce((sum, m) => sum + m.answered, 0)
  }

  /** Send the pending beat now rather than at the end of the debounce. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.send()
  }

  // ── internals ───────────────────────────────────────────────────────────

  private merge(beat: SessionBeat, id: string): void {
    const now = this.now()
    const prev = this.heard.get(id)

    /**
     * Two tabs are one person. Presence lists a member per connection, so
     * without this the room counts you twice and the total is wrong in the one
     * direction that flatters it. Keeping the highest count rather than adding
     * makes the total a lower bound on what the room did, which is the honest
     * reading anyway — and a stale high count cannot outlive `EXPIRE_MS`, so
     * somebody who leaves and comes back starts from zero rather than from
     * whatever their old tab last claimed.
     */
    const answered = prev ? Math.max(prev.beat.answered, beat.answered) : beat.answered

    this.heard.set(id, {
      beat: {
        ...beat,
        id,
        answered,
        // Earliest arrival wins, so a second tab cannot shuffle you down the row.
        since: prev ? Math.min(prev.beat.since, beat.since) : beat.since,
      },
      at: now,
      changedAt: prev && prev.beat.answered === answered ? prev.changedAt : now,
    })

    this.publish()
  }

  /** Merge my own beat locally — Reverb does not echo a whisper back — and send it. */
  private beat(): void {
    this.merge({ ...this.mine }, this.mine.id)
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.send()
    }, DEBOUNCE_MS)
  }

  private send(): void {
    const beat = { ...this.mine }
    if (this.options.send) return void this.options.send(beat)
    try {
      this.channel?.whisper('session', beat)
    } catch {
      // A whisper before the subscription lands is a dropped decoration; the
      // heartbeat sends the same number again ten seconds later.
    }
  }

  /**
   * Tell the screen, but only when a number moved.
   *
   * `/study` is the one place in the app where a repaint is a cost: a strip
   * that redraws on a heartbeat is something moving while a card is on screen,
   * which is the same mistake as chat mid-retrieval. So the signature covers
   * who is here and what they have answered, and deliberately not the derived
   * `state` — a label going stale until the next answer is the right trade
   * against motion during recall.
   */
  private publish(): void {
    const members = this.roster()
    const signature = members.map((m) => `${m.id}:${m.answered}`).join(',')
    if (signature === this.signature) return
    this.signature = signature
    this.options.onChange?.(members, members.reduce((sum, m) => sum + m.answered, 0))
  }

  private onWhisper = (data: unknown, meta?: { user_id?: string | number }): void => {
    this.receive(data, meta?.user_id)
  }

  /**
   * Join the room.
   *
   * No `here()` and no `joining()`, which is not laziness but the one thing
   * about sharing a cached channel that actually bites: `here()` is bound to
   * `pusher:subscription_succeeded`, an event that has already fired if a
   * co-editing session subscribed to this deck first, so a roster built from it
   * would silently be empty. The session is therefore the set of people
   * beating, which needs no replay — and carries its own name, at the cost of a
   * name being as self-reported as the count beside it.
   */
  private async subscribe(): Promise<void> {
    if (this.options.send) {
      this.setStatus('live')
      return
    }

    this.echoApi = await import('./echo.ts').catch(() => null)
    this.echo = this.echoApi?.acquireEcho() ?? null

    // No key configured means no websocket, and Together mode simply is not
    // available — `useStudySession` stays idle and the strip never renders.
    if (!this.echo || this.stopped) return

    this.echoApi?.retainChannel(`deck.${this.options.deckId}`)
    this.channel = this.echo.join(`deck.${this.options.deckId}`)
    this.channel.listenForWhisper('session', this.onWhisper)
    this.setStatus('live')
    this.flush()
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private setStatus(status: SessionStatus): void {
    if (this.status === status) return
    this.status = status
    this.options.onStatus?.(status)
  }
}

/**
 * Anything can arrive on a client event, including from a tab running a build
 * from last month, so nothing is trusted into the map without being checked.
 */
function asBeat(raw: unknown): SessionBeat | null {
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Record<string, unknown>
  if (typeof b.id !== 'string' || !b.id) return null
  if (!Number.isFinite(b.answered) || !Number.isFinite(b.since)) return null
  return {
    id: b.id,
    name: typeof b.name === 'string' && b.name.trim() ? b.name : 'Someone',
    answered: Math.max(0, Math.floor(b.answered as number)),
    since: b.since as number,
    state: b.state === 'caught-up' ? 'caught-up' : 'studying',
  }
}
