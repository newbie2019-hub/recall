/**
 * The smallest zip reader and writer that can carry an `.apkg`.
 *
 * `DecompressionStream`/`CompressionStream` are native everywhere this runs —
 * browsers, Node 18+, React Native's Hermes with a polyfill — so the whole
 * dependency is the container format itself: a central directory, a local
 * header per entry, and CRC-32. A zip library would be ~40 kB to do that.
 *
 * Zip64 is read but never written: Anki collections routinely pass 65,535 media
 * files, which is where the classic 16-bit entry count stops being enough.
 *
 * ponytail: entries are whole `Uint8Array`s, so a 2 GB deck is 2 GB of memory.
 * Stream through the File API when someone actually hits it — the browser gives
 * us random access to the blob, which is what a streaming reader would need.
 */

const EOCD = 0x06054b50
const EOCD64 = 0x06064b50
const EOCD64_LOCATOR = 0x07064b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

export interface ZipEntry {
  name: string
  /** Raw, still compressed. `read()` is what decompresses it. */
  bytes(): Promise<Uint8Array>
  size: number
}

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength)

/**
 * `Blob` accepts a typed array everywhere this runs, but the DOM and Node type
 * definitions disagree about whether a `SharedArrayBuffer`-backed one counts.
 * Casting beats copying the bytes to satisfy a type: these are whole decks.
 */
const part = (b: Uint8Array) => b as unknown as ArrayBuffer

async function inflate(bytes: Uint8Array, method: number): Promise<Uint8Array> {
  if (method === 0) return bytes
  if (method !== 8) throw new Error(`Unsupported zip compression method ${method}`)
  const stream = new Blob([part(bytes)]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * Find the end-of-central-directory record.
 *
 * It is at the very end unless the file carries a comment, so the scan walks
 * backwards over the 64 kB a comment can occupy rather than assuming offset
 * `len - 22`. Anki writes no comment; other tools that repackage decks do.
 */
function findEocd(b: Uint8Array): number {
  const v = view(b)
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--)
    if (v.getUint32(i, true) === EOCD) return i
  throw new Error('Not a zip file')
}

/** Where the central directory starts, and how many entries it holds. */
function directory(b: Uint8Array): { offset: number; count: number } {
  const v = view(b)
  const eocd = findEocd(b)
  let count = v.getUint16(eocd + 10, true)
  let offset = v.getUint32(eocd + 16, true)

  // 0xffff / 0xffffffff are the "look in the zip64 record" sentinels.
  if (count === 0xffff || offset === 0xffffffff) {
    const loc = eocd - 20
    if (loc < 0 || v.getUint32(loc, true) !== EOCD64_LOCATOR) throw new Error('Damaged zip64 index')
    const rec = Number(v.getBigUint64(loc + 8, true))
    if (v.getUint32(rec, true) !== EOCD64) throw new Error('Damaged zip64 index')
    count = Number(v.getBigUint64(rec + 32, true))
    offset = Number(v.getBigUint64(rec + 48, true))
  }
  return { offset, count }
}

/**
 * Zip64 moves oversized values into an extra field rather than growing the
 * fixed header, so a 5 GB entry's real size lives here.
 */
function zip64Extra(b: Uint8Array, at: number, len: number, wants: number): number[] {
  const v = view(b)
  for (let p = at; p + 4 <= at + len; ) {
    const id = v.getUint16(p, true)
    const size = v.getUint16(p + 2, true)
    if (id === 0x0001) {
      const out: number[] = []
      for (let i = 0; i < wants && i * 8 < size; i++) out.push(Number(v.getBigUint64(p + 4 + i * 8, true)))
      return out
    }
    p += 4 + size
  }
  return []
}

/** Every entry in the archive, by name. Nothing is decompressed until asked. */
export function unzip(archive: Uint8Array): Map<string, ZipEntry> {
  const v = view(archive)
  const { offset, count } = directory(archive)
  const entries = new Map<string, ZipEntry>()
  const name = new TextDecoder()

  let p = offset
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== CENTRAL) break
    const method = v.getUint16(p + 10, true)
    const nameLen = v.getUint16(p + 28, true)
    const extraLen = v.getUint16(p + 30, true)
    const commentLen = v.getUint16(p + 32, true)
    let compressed = v.getUint32(p + 20, true)
    let size = v.getUint32(p + 24, true)
    let local = v.getUint32(p + 42, true)

    if (size === 0xffffffff || compressed === 0xffffffff || local === 0xffffffff) {
      // The extra field holds them in this order, each present only if the
      // fixed field was the sentinel.
      const wanted = [size === 0xffffffff, compressed === 0xffffffff, local === 0xffffffff]
      const got = zip64Extra(archive, p + 46 + nameLen, extraLen, wanted.filter(Boolean).length)
      let g = 0
      if (wanted[0]) size = got[g++] ?? size
      if (wanted[1]) compressed = got[g++] ?? compressed
      if (wanted[2]) local = got[g++] ?? local
    }

    const entryName = name.decode(archive.subarray(p + 46, p + 46 + nameLen))
    entries.set(entryName, {
      name: entryName,
      size,
      bytes: async () => {
        // The local header's own name and extra lengths are authoritative, and
        // they legitimately differ from the central directory's.
        if (v.getUint32(local, true) !== LOCAL) throw new Error(`Damaged entry: ${entryName}`)
        const at = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true)
        return inflate(archive.subarray(at, at + compressed), method)
      },
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** Read one entry out, decompressed. */
export async function readZip(archive: Uint8Array, name: string): Promise<Uint8Array | null> {
  const entry = unzip(archive).get(name)
  return entry ? entry.bytes() : null
}

// ── writing ───────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const deflate = async (bytes: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(
    await new Response(
      new Blob([part(bytes)]).stream().pipeThrough(new CompressionStream('deflate-raw')),
    ).arrayBuffer(),
  )

/**
 * Write an archive. Everything is deflated except what deflating would grow —
 * a collection database compresses about five to one, and already-compressed
 * media does not compress at all.
 */
export async function zip(files: Map<string, Uint8Array>): Promise<Uint8Array> {
  const encoder = new TextEncoder()
  const locals: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const [name, raw] of files) {
    const nameBytes = encoder.encode(name)
    const packed = await deflate(raw)
    const stored = packed.length >= raw.length
    const body = stored ? raw : packed
    const crc = crc32(raw)

    const local = new Uint8Array(30 + nameBytes.length)
    const lv = view(local)
    lv.setUint32(0, LOCAL, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(8, stored ? 0 : 8, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, body.length, true)
    lv.setUint32(22, raw.length, true)
    lv.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)

    const entry = new Uint8Array(46 + nameBytes.length)
    const ev = view(entry)
    ev.setUint32(0, CENTRAL, true)
    ev.setUint16(4, 20, true)
    ev.setUint16(6, 20, true)
    ev.setUint16(10, stored ? 0 : 8, true)
    ev.setUint32(16, crc, true)
    ev.setUint32(20, body.length, true)
    ev.setUint32(24, raw.length, true)
    ev.setUint16(28, nameBytes.length, true)
    ev.setUint32(42, offset, true)
    entry.set(nameBytes, 46)

    locals.push(local, body)
    central.push(entry)
    offset += local.length + body.length
  }

  const cdSize = central.reduce((n, c) => n + c.length, 0)
  const end = new Uint8Array(22)
  const dv = view(end)
  dv.setUint32(0, EOCD, true)
  dv.setUint16(8, files.size, true)
  dv.setUint16(10, files.size, true)
  dv.setUint32(12, cdSize, true)
  dv.setUint32(16, offset, true)

  return concat([...locals, ...central, end])
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
