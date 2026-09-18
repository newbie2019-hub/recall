import { stripHtml } from '@recall/core'
import { db } from '@/db/client'
import * as repo from '@/db/repo'
import { cloneGuid, toNoteType, type VersionPayload } from '@/lib/marketplace'

/**
 * Local SQL for the marketplace: which decks came from a listing, what a deck
 * would expose if it were published, and writing a downloaded version into the
 * collection.
 *
 * Separate from `repo.ts` on purpose — nothing here is part of the study loop,
 * and a 1300-line module that five phases append to is how a query nobody owns
 * ends up in the middle of the scheduler.
 */

export interface ClonedDeck {
  id: string
  name: string
  source_listing_id: string
  source_version: number | null
}

/**
 * The deck this listing was cloned into, if any.
 *
 * This is the whole anti-duplicate mechanism: cloning twice has to land on the
 * deck that is already here, not beside it. It is also the only thread back to
 * the publisher, and it is one-way — nothing upstream may ever write through it.
 */
export async function cloneOf(listingId: string): Promise<ClonedDeck | null> {
  const rows = await db.select<ClonedDeck>(
    `SELECT id, name, source_listing_id, source_version
       FROM decks WHERE source_listing_id = ? ORDER BY rowid LIMIT 1`,
    [listingId],
  )
  return rows[0] ?? null
}

export const markClone = (deckId: string, listingId: string, version: number) =>
  db.run('UPDATE decks SET source_listing_id = ?, source_version = ? WHERE id = ?', [
    listingId,
    version,
    deckId,
  ])

// ── cloning ───────────────────────────────────────────────────────────────

const PAGE = 250

/**
 * Write a downloaded version into this collection.
 *
 * Not a second importer: the notes go through `repo.importNotes`, the same call
 * the `.apkg` importer makes, so guid matching, card generation and the review
 * log behave identically whether a deck arrived from Anki or from here. What is
 * marketplace-specific is only the three renamings above it — deck ids to deck
 * paths, the server's note-type spelling to the core one, and `source_guid` to
 * a guid of our own.
 *
 * Re-running it is how an update is applied: notes already here are matched and
 * updated in place, their cards and scheduling untouched. That is the whole
 * reason a version is downloaded rather than a diff.
 */
export async function installVersion(
  listingId: string,
  version: number,
  payload: VersionPayload,
  onProgress: (done: number, total: number) => void = () => {},
): Promise<{ deckId: string; added: number; updated: number }> {
  const byId = new Map(payload.decks.map((d) => [d.id, d]))
  const root = payload.decks.find((d) => d.parent_id === null) ?? payload.decks[0]
  if (!root) throw new Error('That version has no decks in it')

  // An existing clone wins over the published name: the person may have renamed
  // or moved their copy, and an update has to land in the deck they have been
  // studying rather than recreate the original beside it.
  const existing = await cloneOf(listingId)
  const rootId = existing?.id ?? (await repo.deckByPath(root.name))
  const rootPath = (await repo.deckPaths()).get(rootId) ?? root.name

  const deckIds = new Map<string, string>([[root.id, rootId]])
  for (const deck of payload.decks) {
    if (deck.id === root.id) continue
    const parts: string[] = []
    // Depth-capped: `parent_id` is client-written, so a cycle in it is a
    // malformed payload rather than an impossibility.
    let node: (typeof payload.decks)[number] | undefined = deck
    for (let depth = 0; node && node.id !== root.id && depth < 32; depth++) {
      parts.unshift(node.name)
      node = node.parent_id ? byId.get(node.parent_id) : undefined
    }
    deckIds.set(deck.id, await repo.deckByPath([rootPath, ...parts].join('::')))
  }

  const types = payload.note_types.map((t) => toNoteType(t, listingId))
  await repo.upsertNoteTypes(types)
  const typeIds = new Map(payload.note_types.map((t) => [t.id, `market:${listingId}:${t.id}`]))

  let added = 0
  let updated = 0
  const notes = payload.notes.filter((n) => typeIds.has(n.note_type_id))

  for (let offset = 0; offset < notes.length; offset += PAGE) {
    const batch: repo.ImportedNote[] = await Promise.all(
      notes.slice(offset, offset + PAGE).map(async (note) => ({
        guid: await cloneGuid(rootId, note.source_guid),
        noteTypeId: typeIds.get(note.note_type_id)!,
        deckId: deckIds.get(note.deck_id) ?? rootId,
        fields: note.fields,
        tags: String(note.tags ?? '').split(' ').filter(Boolean),
        mod: Date.now(),
        // Neither travels: a card's deck override belongs to the publisher's
        // deck tree, and their review history is theirs. A clone starts new,
        // which is also the only honest starting schedule for someone who has
        // never seen these cards.
        cardDecks: {},
        reviews: [],
      })),
    )

    const written = await repo.importNotes(batch, types)
    added += written.added
    updated += written.updated
    onProgress(Math.min(offset + PAGE, notes.length), notes.length)
  }

  await markClone(rootId, listingId, version)
  return { deckId: rootId, added, updated }
}

// ── what publishing would expose ──────────────────────────────────────────

export interface MediaItem {
  sha256: string
  mime: string
  size: number
}

export interface Disclosure {
  notes: number
  cards: number
  /** The deck and its subdecks — all of them go, not just the one named. */
  decks: number
  tags: string[]
  media: MediaItem[]
  mediaBytes: number
  /** The first line of every note, in collection order. This is the point. */
  samples: string[]
}

const SAMPLES = 200
const MEDIA_REF = /media\/([0-9a-f]{64})/g

/**
 * Everything about to be handed to strangers.
 *
 * Someone publishing a deck built from their own notes is publishing their
 * notes: a name in a mnemonic, a patient in an example, a photo taken on a
 * ward. A count would let them agree to that without seeing it, so this returns
 * the text and the media themselves and the screen shows them.
 *
 * ponytail: reads every note in the subtree into memory to find media
 * references, the same shape as `collectionForExport`. Page it by deck the day
 * a publish runs the tab out of memory.
 */
export async function disclosure(deckId: string): Promise<Disclosure> {
  const counts = await repo.deckContents(deckId)

  const notes = await db.select<{ fields: string; tags: string }>(
    `WITH RECURSIVE sub(id) AS (
       SELECT ? UNION ALL SELECT d.id FROM decks d JOIN sub ON d.parent_id = sub.id
     )
     SELECT fields, tags FROM notes WHERE deck_id IN (SELECT id FROM sub) ORDER BY rowid`,
    [deckId],
  )

  const tags = new Set<string>()
  const shas = new Set<string>()
  const samples: string[] = []

  for (const note of notes) {
    for (const tag of String(note.tags ?? '').split(' ').filter(Boolean)) tags.add(tag)
    for (const match of note.fields.matchAll(MEDIA_REF)) shas.add(match[1]!)
    if (samples.length < SAMPLES) {
      const values = Object.values(JSON.parse(note.fields) as Record<string, string>)
      const first = values.map((v) => stripHtml(v).trim()).find(Boolean)
      if (first) samples.push(first)
    }
  }

  const media = shas.size
    ? await db.select<MediaItem>(
        `SELECT sha256, mime, size FROM media WHERE sha256 IN (${[...shas].map(() => '?').join(',')})`,
        [...shas],
      )
    : []

  return {
    notes: counts.notes,
    cards: counts.cards,
    decks: counts.decks,
    tags: [...tags].sort(),
    media,
    mediaBytes: media.reduce((sum, m) => sum + m.size, 0),
    samples,
  }
}
