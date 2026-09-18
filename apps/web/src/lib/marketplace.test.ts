/**
 * The marketplace client. What is checked here is what a wrong answer costs:
 * a token leaked onto a public request, an error the screens cannot branch on,
 * and an update offered for a deck the person has since made their own.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '@recall/core'
import {
  formatBytes, getListing, listListings, reportListing, updateAvailable,
} from './marketplace.ts'

interface Call { url: string; init: RequestInit }

function stubFetch(responses: Array<{ status?: number; body: unknown } | Error>) {
  const calls: Call[] = []
  const queue = [...responses]
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init })
    const next = queue.shift()
    if (next === undefined) throw new Error('stub fetch ran out of responses')
    if (next instanceof Error) throw next
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof globalThis.fetch
  return calls
}

const envelope = (data: unknown, extra: Record<string, unknown> = {}) => ({
  body: { data, server_time: Date.now(), ...extra },
})

const header = (call: Call, name: string) =>
  (call.init.headers as Record<string, string> | undefined)?.[name]

test('browse sends no Authorization when signed out — /explore is public', async () => {
  const calls = stubFetch([envelope([], { next_cursor: 7 })])
  const result = await listListings({ q: 'heart', sort: 'recent' })

  assert.equal(header(calls[0]!, 'Authorization'), undefined)
  assert.match(calls[0]!.url, /marketplace\/listings\?q=heart&sort=recent$/)
  assert.deepEqual(result, { items: [], next_cursor: 7 })
})

test('empty filters are left off the query rather than sent blank', async () => {
  const calls = stubFetch([envelope([])])
  await listListings({ q: '', tag: undefined })
  assert.ok(!calls[0]!.url.includes('?'), calls[0]!.url)
})

test('a 403 becomes a forbidden ApiError, which is how moderation shows "not found"', async () => {
  stubFetch([{ status: 403, body: { error: { code: 'forbidden', message: 'Nope' } } }])
  const error = await getListing('abc').catch((e: unknown) => e)
  assert.ok(error instanceof ApiError)
  assert.equal(error.code, 'forbidden')
  assert.equal(error.status, 403)
})

test('a dead network is `offline`, not a crash', async () => {
  stubFetch([new TypeError('Failed to fetch')])
  const error = await reportListing('abc', { reason: 'spam', detail: '' }).catch((e: unknown) => e)
  assert.ok(error instanceof ApiError)
  assert.equal(error.code, 'offline')
})

test('a gateway that answers HTML still reports its status', async () => {
  globalThis.fetch = (async () => new Response('<html>502</html>', { status: 502 })) as typeof globalThis.fetch
  const error = await getListing('abc').catch((e: unknown) => e)
  assert.ok(error instanceof ApiError)
  assert.equal(error.code, 'server_error')
})

test('an update is offered only when the clone is behind a known version', () => {
  assert.equal(updateAvailable({ source_version: 1 }, { version: 2 }), true)
  assert.equal(updateAvailable({ source_version: 2 }, { version: 2 }), false)
  assert.equal(updateAvailable({ source_version: 3 }, { version: 2 }), false)
  // Never cloned, and cloned before versions were recorded: both stay quiet.
  assert.equal(updateAvailable(null, { version: 9 }), false)
  assert.equal(updateAvailable({ source_version: null }, { version: 9 }), false)
})

test('sizes are quoted in the units the download screen promises', () => {
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2.0 kB')
  assert.equal(formatBytes(1024 * 1024 * 40), '40 MB')
})
