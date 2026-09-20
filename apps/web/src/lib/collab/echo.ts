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
