import type { ApiClient } from '@recall/core'
import { db } from '@/db/client'

/**
 * Getting the bytes onto the device that needs them.
 *
 * Media has been content-addressed since Phase 1 and its *metadata* has synced
 * since Phase 5 — the row saying "this deck uses image abc123" travelled, and
 * the image never did. So a deck of anatomy plates published, cloned and
 * co-edited perfectly and arrived blank, for four phases, in the one vertical
 * this app is aimed at.
 *
 * Three movements, and the hash is what makes all three simple:
 *
 * - **Up:** offer every local sha, upload what the server does not have.
 * - **Down:** for every `media/<sha>` a note refers to that this device lacks,
 *   fetch it from the account's own store.
 * - **Across:** a cloned deck's images come from the *published version*, not
 *   from the publisher's account, because the version's manifest is what says
 *   which of the publisher's files are public.
 *
 * None of it needs per-device state. Naming a file by its own digest means the
 * question "do you have this?" has one answer that cannot go stale, so a
 * reinstalled device asks rather than remembers.
 */

/** A note refers to media as `media/<sha256>`; see `lib/media.ts`. */
const REF = /media\/([a-f0-9]{64})/gi

/**
 * Bytes are big and a stalled sync is worse than a slow one, so each pass moves
 * a bounded number of files and the next pass picks up the rest.
 */
const BATCH = 25

export interface MediaProgress {
  done: number
  total: number
}

/** Every hash this device holds bytes for. */
async function localShas(): Promise<string[]> {
  const rows = await db.select<{ sha256: string }>('SELECT sha256 FROM media')
  return rows.map((r) => r.sha256)
}

/**
 * Every hash the collection *refers to*, whether or not the bytes are here.
 *
 * Scanned from the raw field text rather than from a parsed document: the
 * fields are HTML, a reference can sit in an `<img>`, a `[sound:…]` or a note
 * type's CSS, and a regex over the text finds all three without teaching this
 * module what a card looks like.
 */
async function referencedShas(): Promise<string[]> {
  const rows = await db.select<{ text: string }>(
    `SELECT fields AS text FROM notes
     UNION ALL SELECT css AS text FROM note_types
     UNION ALL SELECT templates AS text FROM note_types`,
  )

  const found = new Set<string>()
  for (const row of rows) {
    for (const match of String(row.text ?? '').matchAll(REF)) found.add(match[1]!.toLowerCase())
  }
  return [...found]
}

/**
 * Push local files the server does not have yet.
 *
 * Returns how many went up. A failure on one file is logged past rather than
 * thrown: one unreadable blob must not stop the other two hundred, and the
 * next pass will try it again.
 */
export async function pushMedia(client: ApiClient, onProgress?: (p: MediaProgress) => void): Promise<number> {
  const mine = await localShas()
  if (!mine.length) return 0

  const held = await client.heldMedia(mine)
  const missing = mine.filter((sha) => !held.has(sha)).slice(0, BATCH)
  if (!missing.length) return 0

  let done = 0
  for (const sha of missing) {
    const [row] = await db.select<{ mime: string; bytes: Uint8Array<ArrayBuffer> }>(
      'SELECT mime, bytes FROM media WHERE sha256 = ?',
      [sha],
    )
    if (!row) continue

    try {
      await client.putMedia(sha, row.bytes, row.mime)
      done++
    } catch {
      // Offline, refused, or a type the server will not store. The metadata
      // still syncs and the next pass tries again; a card missing its picture
      // is worth strictly more than a sync that stops.
    }
    onProgress?.({ done, total: missing.length })
  }

  return done
}

/**
 * Fetch bytes this device is missing for media its notes already reference.
 *
 * The second half of "a card authored on a laptop shows its diagram on a
 * phone". The metadata arrives through the ordinary sync; this is what makes
 * the `<img>` resolve.
 */
export async function pullMedia(client: ApiClient, onProgress?: (p: MediaProgress) => void): Promise<number> {
  const [referenced, mine] = await Promise.all([referencedShas(), localShas()])
  const have = new Set(mine)
  const wanted = referenced.filter((sha) => !have.has(sha)).slice(0, BATCH)
  if (!wanted.length) return 0

  let done = 0
  for (const sha of wanted) {
    try {
      await store(sha, await client.getMedia(sha))
      done++
    } catch {
      // A 404 here is ordinary: the reference may point at a file the
      // publisher never had, or at one uploaded from a device that has not
      // pushed yet. Neither is worth failing a sync over.
    }
    onProgress?.({ done, total: wanted.length })
  }

  return done
}

/**
 * Fetch a cloned deck's images from the published version that carried them.
 *
 * From the *version*, never from the publisher's account: the manifest inside
 * that version is the list of files the publisher made public by publishing,
 * and reading their account directly would make one publish a key to a private
 * library. It is also why this works signed out — a listing is shared with
 * people who have not signed up yet, and a deck whose plates need a login
 * arrives broken for exactly its intended audience.
 *
 * Unbounded on purpose, unlike the sync passes: this runs once, with a progress
 * bar, while somebody is watching a deck arrive.
 */
export async function pullVersionMedia(
  client: ApiClient,
  listingId: string,
  version: number,
  manifest: { sha256: string }[],
  onProgress?: (p: MediaProgress) => void,
): Promise<number> {
  if (!manifest?.length) return 0

  const have = new Set(await localShas())
  const wanted = manifest.map((m) => m.sha256.toLowerCase()).filter((sha) => !have.has(sha))

  let done = 0
  for (const sha of wanted) {
    try {
      await store(sha, await client.getVersionMedia(listingId, version, sha))
      done++
    } catch {
      // One missing plate is a card with a broken image; a thrown error here
      // would be a clone that failed after the notes already landed.
    }
    onProgress?.({ done, total: wanted.length })
  }

  return done
}

/**
 * Write bytes under the hash they were fetched by.
 *
 * Not re-hashed here. The server checks on upload and serves by hash, so the
 * only thing a second digest on this side would catch is a corrupted transfer
 * — which `Content-Length` and TLS already cover, and which would cost a full
 * re-hash of every image on every sync to look for.
 */
async function store(sha: string, blob: Blob): Promise<void> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  await db.run(
    `INSERT INTO media (sha256, mime, size, bytes, created_at) VALUES (?,?,?,?,?)
     ON CONFLICT(sha256) DO NOTHING`,
    [sha, blob.type || 'application/octet-stream', bytes.length, bytes, Date.now()],
  )
}
