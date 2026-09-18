/**
 * The API client. Everything here is a rule from PLAN.md §2.6 that an installed
 * phone would otherwise discover the hard way, on a bad network, months later.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiClient, ApiError, type TokenStore } from './client.ts'

const memoryTokens = (initial: string | null = null): TokenStore => {
  let token = initial
  return {
    get: async () => token,
    set: async (v) => { token = v },
    clear: async () => { token = null },
  }
}

interface Call { url: string; init: RequestInit }

/** A fetch that replays a queued list of responses and records what it was sent. */
function stubFetch(responses: Array<{ status?: number; body: unknown } | Error>) {
  const calls: Call[] = []
  const queue = [...responses]
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init })
    const next = queue.shift()
    if (next === undefined) throw new Error('stub fetch ran out of responses')
    if (next instanceof Error) throw next
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

const envelope = (data: unknown, extra: Record<string, unknown> = {}) =>
  ({ body: { data, server_time: Date.now(), ...extra } })

const client = (responses: Parameters<typeof stubFetch>[0], over: Partial<ConstructorParameters<typeof ApiClient>[0]> = {}) => {
  const { fetch, calls } = stubFetch(responses)
  return {
    calls,
    api: new ApiClient({
      baseUrl: 'https://api.test/api/v1',
      tokens: memoryTokens('existing-token'),
      fetch,
      sleep: async () => {}, // the backoff is asserted by call count, not by waiting
      ...over,
    }),
  }
}

test('a signed-in request carries the bearer token and nothing else does', async () => {
  const { api, calls } = client([
    envelope({ id: 'u1', name: 'Yvan', email: 'y@test', email_verified: false }),
    envelope({ user: {}, device: {}, token: 'fresh', expires_at: null }),
  ])

  await api.me()
  assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, 'Bearer existing-token')

  // Sign-in must not send the old token: the whole point is that the caller may
  // not have one, or may have one belonging to a different account.
  await api.login({ email: 'y@test', password: 'x', device_name: 'iPhone' })
  assert.equal((calls[1]!.init.headers as Record<string, string>).Authorization, undefined)
})

test('signing in stores the token so the next request is authenticated', async () => {
  const tokens = memoryTokens(null)
  const { fetch } = stubFetch([
    envelope({ user: {}, device: {}, token: 'issued-token', expires_at: null }),
    envelope({ id: 'u1' }),
  ])
  const api = new ApiClient({ baseUrl: 'https://api.test/api/v1', tokens, fetch })

  await api.login({ email: 'y@test', password: 'x', device_name: 'iPhone' })
  assert.equal(await tokens.get(), 'issued-token')
})

test('a 401 is reported but never clears the collection or the caller state', async () => {
  let warned = 0
  const tokens = memoryTokens('stale-token')
  const { fetch } = stubFetch([
    { status: 401, body: { error: { code: 'unauthenticated', message: 'Sign in again to keep syncing.' } } },
  ])
  const api = new ApiClient({
    baseUrl: 'https://api.test/api/v1', tokens, fetch,
    onUnauthenticated: () => { warned++ },
  })

  const error = await api.me().then(() => null, (e: ApiError) => e)
  assert.ok(error instanceof ApiError)
  assert.equal(error.code, 'unauthenticated')
  assert.ok(error.needsSignIn)
  assert.equal(warned, 1, 'the app is told once, so it can show one banner')
  // The invariant: a 401 must never take the collection away. The client does
  // not even drop the token — that is the app's decision, not the transport's.
  assert.equal(await tokens.get(), 'stale-token')
})

test('an idempotent request retries a server error and then succeeds', async () => {
  const { api, calls } = client([
    { status: 503, body: { error: { code: 'server_error', message: 'busy' } } },
    { status: 503, body: { error: { code: 'server_error', message: 'busy' } } },
    envelope({ applied: { reviews: 2 }, skipped: {} }),
  ])

  const result = await api.push({ reviews: [{ id: 'r1' }, { id: 'r2' }] })
  assert.deepEqual(result.applied, { reviews: 2 })
  assert.equal(calls.length, 3, 'two failures, then the one that worked')
})

test('a dropped connection is retried, because the request never landed', async () => {
  const { api, calls } = client([
    new TypeError('Failed to fetch'),
    envelope({ changes: {}, }, { next_cursor: null, has_more: false }),
  ])

  await api.pull(0)
  assert.equal(calls.length, 2)
})

test('register is never retried, so a second account cannot appear', async () => {
  const { api, calls } = client([
    { status: 503, body: { error: { code: 'server_error', message: 'busy' } } },
  ])

  const error = await api.register({
    name: 'Yvan', email: 'y@test', password: 'x', device_name: 'iPhone',
  }).then(() => null, (e: ApiError) => e)

  assert.equal(error?.code, 'server_error')
  // A retried register that actually succeeded the first time comes back as
  // "email already taken", which reads as though your own account is in the way.
  assert.equal(calls.length, 1)
})

test('retries give up rather than hammering a server that is down', async () => {
  const { api, calls } = client(
    Array.from({ length: 6 }, () => ({ status: 500, body: { error: { code: 'server_error', message: 'down' } } })),
    { maxRetries: 2 },
  )

  const error = await api.me().then(() => null, (e: ApiError) => e)
  assert.equal(error?.code, 'server_error')
  assert.equal(calls.length, 3, 'the first attempt plus two retries')
})

test('a validation failure is not retried and carries its field errors', async () => {
  const { api, calls } = client([
    {
      status: 422,
      body: {
        error: {
          code: 'validation_failed',
          message: 'The email has already been taken.',
          meta: { email: ['The email has already been taken.'] },
        },
      },
    },
  ])

  const error = await api.push({ decks: [{ id: 'd1' }] }).then(() => null, (e: ApiError) => e)
  assert.equal(error?.code, 'validation_failed')
  assert.deepEqual(error?.meta, { email: ['The email has already been taken.'] })
  assert.equal(calls.length, 1, 'sending the same invalid body again cannot help')
})

test('a gateway that does not speak our envelope still yields a usable error', async () => {
  const { fetch } = stubFetch([])
  const api = new ApiClient({
    baseUrl: 'https://api.test/api/v1',
    tokens: memoryTokens('t'),
    sleep: async () => {},
    maxRetries: 0,
    // A 502 from a proxy: HTML, not JSON.
    fetch: (async () => new Response('<html>502</html>', { status: 502 })) as unknown as typeof globalThis.fetch,
  })
  void fetch

  const error = await api.me().then(() => null, (e: ApiError) => e)
  assert.equal(error?.code, 'server_error')
  assert.equal(error?.status, 502, 'the status survives a body we cannot parse')
})

test('pull passes its cursor through and reports where to resume', async () => {
  const { api, calls } = client([
    envelope(
      { decks: [{ id: 'd1', revision: 7, deleted: false }], notes: [] },
      { next_cursor: 7, has_more: true },
    ),
  ])

  const page = await api.pull(3, 100)
  assert.match(calls[0]!.url, /cursor=3/)
  assert.match(calls[0]!.url, /limit=100/)
  assert.equal(page.next_cursor, 7)
  assert.equal(page.has_more, true)
  assert.equal(page.changes.decks[0]!.revision, 7)
})

test('the clock skew is read off every response rather than costing a request', async () => {
  const { fetch } = stubFetch([
    { body: { data: { id: 'u1' }, server_time: Date.now() + 90_000 } },
  ])
  const api = new ApiClient({ baseUrl: 'https://api.test/api/v1', tokens: memoryTokens('t'), fetch })

  await api.me()
  assert.ok(api.clockSkewMs > 60_000, 'a device an hour and a half fast is detectable')
})

test('signing out drops the token even when the call fails', async () => {
  const tokens = memoryTokens('live-token')
  const { fetch } = stubFetch([new TypeError('Failed to fetch')])
  const api = new ApiClient({
    baseUrl: 'https://api.test/api/v1', tokens, fetch, sleep: async () => {}, maxRetries: 0,
  })

  await api.logout().catch(() => {})
  // The person asked to be signed out; a flaky network is not a reason to leave
  // a live token sitting on the device.
  assert.equal(await tokens.get(), null)
})
