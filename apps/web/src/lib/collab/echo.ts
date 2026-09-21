import Echo from 'laravel-echo'
import Pusher from 'pusher-js'
import { collabBaseUrl } from './transport.ts'

/**
 * The websocket, built once and shared by every deck that opens a session.
 *
 * Reverb speaks the Pusher protocol, so `pusher-js` is the client and
 * `laravel-echo` is the thin layer that knows about private and presence
 * channels. Neither is a framework choice made here — PHASES §9 fixes Reverb as
 * the transport, and these are what talk to it.
 *
 * Two things are deliberate:
 *
 * **Auth goes to `/api/v1/broadcasting/auth` with a bearer token**, not to
 * Laravel's default endpoint. This API has no session and no CSRF token
 * (PLAN.md §2.6), so the default route — which sits behind `web` middleware —
 * would answer 419 to every subscription.
 *
 * **It is built lazily and torn down when the last deck leaves.** Most decks
 * are private and most sessions never open one; a socket held open for an
 * audience of one is a connection, a heartbeat and a reconnect loop bought for
 * nothing.
 */

type EchoInstance = InstanceType<typeof Echo>

let echo: EchoInstance | null = null
let refs = 0

const TOKEN_KEY = 'recall.token'

function build(): EchoInstance {
  const key = import.meta.env?.VITE_REVERB_APP_KEY ?? ''
  const host = import.meta.env?.VITE_REVERB_HOST ?? 'localhost'
  const port = Number(import.meta.env?.VITE_REVERB_PORT ?? 8080)
  const scheme = import.meta.env?.VITE_REVERB_SCHEME ?? 'http'

  return new Echo({
    broadcaster: 'reverb',
    Pusher,
    key,
    wsHost: host,
    wsPort: port,
    wssPort: port,
    forceTLS: scheme === 'https',
    enabledTransports: ['ws', 'wss'],
    authEndpoint: `${collabBaseUrl()}/broadcasting/auth`,
    auth: {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${globalThis.localStorage?.getItem(TOKEN_KEY) ?? ''}`,
      },
    },
  })
}

/** Whether a websocket can be opened at all — no key, no live session. */
export const collabConfigured = (): boolean => Boolean(import.meta.env?.VITE_REVERB_APP_KEY)

/**
 * Take a reference to the shared connection. Every caller must release it.
 */
export function acquireEcho(): EchoInstance | null {
  if (!collabConfigured()) return null
  if (!echo) echo = build()
  refs++
  return echo
}

export function releaseEcho(): void {
  refs = Math.max(0, refs - 1)
  if (refs === 0 && echo) {
    echo.disconnect()
    echo = null
  }
}

/**
 * How many live objects are holding each named channel.
 *
 * The socket was already refcounted and the *channel* was not, which is a
 * difference nobody noticed until two features wanted the same one. Echo caches
 * a presence channel by name and hands the same object to every caller, so
 * `echo.leave('deck.x')` is not "I am done with it" — it is "nobody is on this
 * channel any more", declared unilaterally. A co-editing session closing a deck
 * would silently unsubscribe a study session running on that deck in the same
 * tab, and the symptom would be a room that stops updating for no visible
 * reason.
 *
 * So: hold it while you use it, and let go. The last one out leaves. Callers
 * still unbind their own listeners, because a channel that survives must not
 * keep calling back into something that has stopped.
 */
const channelRefs = new Map<string, number>()

export function retainChannel(name: string): void {
  channelRefs.set(name, (channelRefs.get(name) ?? 0) + 1)
}

/** @returns whether this was the last holder, and the channel was left. */
export function releaseChannel(name: string): boolean {
  const left = (channelRefs.get(name) ?? 1) - 1
  if (left > 0) {
    channelRefs.set(name, left)
    return false
  }
  channelRefs.delete(name)
  echo?.leave(name)
  return true
}

/**
 * Reverb's id for this connection, which the server needs to avoid echoing an
 * update back to the person who typed it.
 *
 * Null until the socket is up — an update sent before then is simply
 * rebroadcast to its author too, and applying a Yjs update twice is a no-op.
 */
export function socketId(): string | null {
  try {
    return echo?.socketId() ?? null
  } catch {
    return null
  }
}
