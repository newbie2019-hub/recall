/**
 * The marketplace client. What is checked here is what a wrong answer costs:
 * a token leaked onto a public request, an error the screens cannot branch on,
 * a guid that orphans every clone on its next update, and an update offered for
 * a deck the person has since made their own.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '@recall/core'
import {
  cloneGuid, formatBytes, getListing, listListings, listingUpdates, rateListing,
  reportListing, toNoteType, updateAvailable,
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
  const calls = stubFetch([envelope([], { next_cursor: 20 })])
  const result = await listListings({ q: 'heart' })

  assert.equal(header(calls[0]!, 'Authorization'), undefined)
  assert.match(calls[0]!.url, /marketplace\/listings\?q=heart$/)
  assert.deepEqual(result, { items: [], next_cursor: 20 })
})

test('empty filters are left off the query rather than sent blank', async () => {
  const calls = stubFetch([envelope([])])
  await listListings({ q: '', tag: undefined })
  assert.ok(!calls[0]!.url.includes('?'), calls[0]!.url)
})

test('the preview rides beside `data` and carries the note types a card needs', async () => {
  stubFetch([
    envelope(
      { id: 'l1', title: 'Heart' },
      {
        preview: { notes: [{ source_guid: 'g' }], note_types: [{ id: 'nt-1' }] },
        your_rating: 3,
      },
    ),
  ])
  const { listing, preview, yourRating } = await getListing('l1')
  assert.equal(listing.title, 'Heart')
  assert.equal(preview.notes.length, 1)
  // Without these the listing page would download the whole version to draw a
  // sample card for somebody who has not decided to clone anything.
  assert.equal(preview.note_types.length, 1)
  assert.equal(yourRating, 3)
})

test('a listing published before previews existed reads as empty, not as a crash', async () => {
  stubFetch([envelope({ id: 'l1', title: 'Heart' })])
  const { preview, yourRating } = await getListing('l1')
  assert.deepEqual(preview, { notes: [], note_types: [] })
  assert.equal(yourRating, 0)
})

test('the update check asks once for the whole collection', async () => {
  const calls = stubFetch([
    envelope([
      { id: 'l1', title: 'Heart', latest_version: 4 },
      { id: 'l2', title: 'Lungs', latest_version: 1 },
    ]),
  ])
  const latest = await listingUpdates(['l1', 'l2'])

  assert.equal(calls.length, 1)
  assert.match(calls[0]!.url, /marketplace\/updates\?ids=l1%2Cl2$/)
  assert.equal(latest.get('l1'), 4)
  assert.equal(latest.get('l2'), 1)
})

test('no cloned decks means no request at all', async () => {
  const calls = stubFetch([])
  assert.equal((await listingUpdates([])).size, 0)
  assert.equal(calls.length, 0)
})

test('rating is a PUT carrying the stars, and its refusal survives as an ApiError', async () => {
  const calls = stubFetch([envelope({ rating_count: 2, rating_sum: 9, your_rating: 5 })])
  const summary = await rateListing('l1', 5)

  assert.equal(calls[0]!.init.method, 'PUT')
  assert.equal(JSON.parse(String(calls[0]!.init.body)).stars, 5)
  assert.equal(summary.your_rating, 5)

  // The 403 is the "clone it first" rule, and its message is the instruction.
  stubFetch([{ status: 403, body: { error: { code: 'forbidden', message: 'Add this deck first.' } } }])
  const error = await rateListing('l1', 5).catch((e: unknown) => e)
  assert.ok(error instanceof ApiError)
  assert.equal(error.message, 'Add this deck first.')
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

/**
 * The fixture is the server's own: `substr(hash('sha256', $deckId.':'.$sourceGuid), 0, 16)`
 * in App\Services\Marketplace\CloneGuid. If these two ever disagree, every clone
 * duplicates itself on its next update instead of merging.
 */
test('a cloned note gets the same guid the server would derive', async () => {
  assert.equal(await cloneGuid('deck-1', 'upstream00000000'), '5eecef7ee291e766')
  // Same note, two clones: different decks, so different guids and no collision.
  assert.notEqual(
    await cloneGuid('deck-1', 'upstream00000000'),
    await cloneGuid('deck-2', 'upstream00000000'),
  )
  assert.match(await cloneGuid('deck-1', 'upstream00000000'), /^[0-9a-f]{16}$/)
})

test('a published note type is renamed into the core spelling, minus the deck override', () => {
  const nt = toNoteType(
    {
      id: 'nt-1', name: 'Basic', fields: ['Front', 'Back'],
      templates: [{ name: 'Card 1', qfmt: '{{Front}}', afmt: '{{Back}}', deckOverride: 'their-deck' }],
      css: '.card{}', kind: 'standard', ord_field: null, sort_field: 1,
      field_config: [], anki_extra: {},
    },
    'listing-9',
  )

  assert.equal(nt.id, 'market:listing-9:nt-1')
  assert.equal(nt.sortField, 1)
  assert.equal(nt.ordField, undefined)
  // A deck override points into the publisher's tree and must not come across.
  assert.equal(nt.templates[0]!.deckOverride, null)
})

test('an update is offered only when the clone is behind a known version', () => {
  assert.equal(updateAvailable({ source_version: 1 }, { latest_version: 2 }), true)
  assert.equal(updateAvailable({ source_version: 2 }, { latest_version: 2 }), false)
  assert.equal(updateAvailable({ source_version: 3 }, { latest_version: 2 }), false)
  // Never cloned, and cloned before versions were recorded: both stay quiet.
  assert.equal(updateAvailable(null, { latest_version: 9 }), false)
  assert.equal(updateAvailable({ source_version: null }, { latest_version: 9 }), false)
})

test('sizes are quoted in the units the download screen promises', () => {
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2.0 kB')
  assert.equal(formatBytes(1024 * 1024 * 40), '40 MB')
})
