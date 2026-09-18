import { decompress } from 'fzstd'
import { decodeProto, protoBytes, protoString, unzip, type ZipEntry } from '@recall/core'

/**
 * Opening the `.apkg` container itself.
 *
 * Three formats are in circulation and a deck downloaded today may be any of
 * them:
 *
 * | entry | schema | since |
 * |---|---|---|
 * | `collection.anki2` | 11 | Anki 2.0 |
 * | `collection.anki21` | 11 or 18 | Anki 2.1 |
 * | `collection.anki21b` | 18, zstd-compressed | Anki 2.1.50 |
 *
 * The newest is preferred where several are present — 2.1 exports ship a
 * deliberately empty `collection.anki2` beside the real one so that Anki 2.0
 * shows a readable error instead of a crash.
 */

/** zstd is the one compressor no browser ships. ~8 kB, decompress only. */
const unzstd = (bytes: Uint8Array) => decompress(bytes)

export interface Apkg {
  /** The SQLite bytes, decompressed. */
  collection: Uint8Array
  /** Media filename → the zip entry holding its bytes. */
  media: Map<string, () => Promise<Uint8Array>>
}

export async function openApkg(archive: Uint8Array): Promise<Apkg> {
  const entries = unzip(archive)
  const zstd = entries.has('collection.anki21b')

  const name = ['collection.anki21b', 'collection.anki21', 'collection.anki2']
    .find((n) => entries.has(n))
  if (!name) throw new Error('That does not look like an Anki deck — no collection inside')

  const raw = await entries.get(name)!.bytes()
  return {
    collection: zstd && name.endsWith('b') ? unzstd(raw) : raw,
    media: await readMediaMap(entries, zstd),
  }
}

/**
 * Which numbered entry holds which filename.
 *
 * Anki stores media as `0`, `1`, `2`… with a manifest beside them, because a
 * zip cannot portably carry the filenames people actually use — a deck from a
 * Japanese collection has names no Windows build would agree to unpack. The
 * manifest is JSON in the legacy format and a protobuf message in the new one,
 * where the media files are individually zstd-compressed as well.
 */
async function readMediaMap(
  entries: Map<string, ZipEntry>,
  zstd: boolean,
): Promise<Map<string, () => Promise<Uint8Array>>> {
  const manifest = entries.get('media')
  const out = new Map<string, () => Promise<Uint8Array>>()
  if (!manifest) return out

  const raw = await manifest.bytes()
  const open = (key: string) => async () => {
    const bytes = await entries.get(key)!.bytes()
    return zstd ? unzstd(bytes) : bytes
  }

  if (!zstd) {
    const map: Record<string, string> = JSON.parse(new TextDecoder().decode(raw))
    for (const [index, filename] of Object.entries(map))
      if (entries.has(index)) out.set(filename, open(index))
    return out
  }

  // MediaEntries { repeated MediaEntry entries = 1 }
  // MediaEntry   { string name = 1; uint32 size = 2; bytes sha1 = 3; }
  // The entries are positional: the nth one is the file named "n".
  const list = decodeProto(unzstd(raw))
  protoBytes(list, 1).forEach((entry, i) => {
    const filename = protoString(decodeProto(entry), 1)
    if (filename && entries.has(String(i))) out.set(filename, open(String(i)))
  })
  return out
}

/**
 * An image's natural size, which is what turns Anki's pixel occlusion
 * coordinates into the 0–1 ones we store (`normaliseOcclusion`).
 */
export async function imageSize(bytes: Uint8Array, mime: string) {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes as unknown as ArrayBuffer], { type: mime }))
    const size = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return size
  } catch {
    // An SVG or a format this browser cannot decode. The caller leaves the
    // occlusion field alone rather than writing coordinates it guessed.
    return null
  }
}
