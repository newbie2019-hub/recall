import { db } from '@/db/client'

/**
 * Media is content-addressed: the sha256 of the bytes is the primary key and
 * the only name a note ever stores. Paste the same diagram into twenty notes
 * and it is stored once; Phase 4 gets resumable upload and dedupe for free,
 * and Phase 3's importer just maps `image.png` → its hash.
 *
 * Notes refer to media as `media/<sha256>` inside their HTML. Nothing stores a
 * blob: URL — those die with the page.
 */

const urls = new Map<string, string>()

export async function storeMedia(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const sha = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')

  await db.run(
    `INSERT INTO media (sha256, mime, size, bytes, created_at) VALUES (?,?,?,?,?)
     ON CONFLICT(sha256) DO NOTHING`,
    [sha, file.type || 'application/octet-stream', bytes.length, bytes, Date.now()],
  )
  urls.set(sha, URL.createObjectURL(file))
  return sha
}

export async function mediaUrl(sha: string): Promise<string | null> {
  const cached = urls.get(sha)
  if (cached) return cached

  const [row] = await db.select<{ mime: string; bytes: Uint8Array<ArrayBuffer> }>(
    'SELECT mime, bytes FROM media WHERE sha256 = ?',
    [sha],
  )
  if (!row) return null

  const url = URL.createObjectURL(new Blob([row.bytes], { type: row.mime }))
  urls.set(sha, url)
  return url
}

export const mediaRef = (sha: string) => `media/${sha}`

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav',
  m4a: 'audio/mp4', opus: 'audio/opus', flac: 'audio/flac',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
}

/**
 * Anki addresses media by filename, so the only clue to a file's type is its
 * extension — there is no `Content-Type` inside a zip. Getting it wrong shows
 * up as a broken image, so unknown extensions get the generic type and the
 * browser sniffs.
 */
export const mimeOf = (filename: string): string =>
  MIME[filename.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'

/** Store raw bytes we already have, as `storeMedia` does for a picked file. */
export async function storeBytes(bytes: Uint8Array, mime: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  const sha = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  await db.run(
    `INSERT INTO media (sha256, mime, size, bytes, created_at) VALUES (?,?,?,?,?)
     ON CONFLICT(sha256) DO NOTHING`,
    [sha, mime, bytes.length, bytes, Date.now()],
  )
  return sha
}

/** The bytes behind a hash, for the exporter. */
export const mediaBytes = (sha: string) =>
  db.select<{ mime: string; bytes: Uint8Array }>(
    'SELECT mime, bytes FROM media WHERE sha256 = ?', [sha],
  ).then((r) => r[0] ?? null)
