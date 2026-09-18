/**
 * Just enough protobuf to read Anki's schema-18 config blobs.
 *
 * Anki 2.1.50 moved note types and decks out of JSON in the `col` table and
 * into real tables whose `config` column is a serialised protobuf message. The
 * names and ordinals we need are still plain columns; what is in the blob is
 * the template's question and answer format, the note type's CSS and the
 * handful of fields we carry opaque.
 *
 * Decoding the wire format needs no schema — a message is a flat list of
 * (field number, value) pairs — so this is a reader, not a compiler, and the
 * field numbers live with the code that knows what they mean.
 */

export type ProtoField = bigint | Uint8Array
export type ProtoMessage = Map<number, ProtoField[]>

const EMPTY: ProtoMessage = new Map()

function varint(b: Uint8Array, at: number): [bigint, number] {
  let out = 0n
  let shift = 0n
  let p = at
  // 10 bytes is the most a 64-bit varint can occupy; past that the blob is
  // corrupt and the loop would otherwise never end.
  for (; p < b.length && p - at < 10; p++) {
    out |= BigInt(b[p]! & 0x7f) << shift
    if (!(b[p]! & 0x80)) return [out, p + 1]
    shift += 7n
  }
  throw new Error('Bad protobuf varint')
}

/**
 * Decode one message into field number → values.
 *
 * Repeated fields arrive as several entries under the same number, which is
 * exactly the wire format's own rule, so nothing has to be declared repeated.
 * A blob we cannot read yields an empty message rather than throwing: one
 * unreadable template must not cost the other 4,000 notes their import.
 */
export function decodeProto(bytes: Uint8Array | null | undefined): ProtoMessage {
  if (!bytes?.length) return EMPTY
  const out: ProtoMessage = new Map()
  const push = (n: number, v: ProtoField) => out.set(n, [...(out.get(n) ?? []), v])

  try {
    let p = 0
    while (p < bytes.length) {
      const [tag, next] = varint(bytes, p)
      p = next
      const field = Number(tag >> 3n)
      switch (Number(tag & 7n)) {
        case 0: {
          const [v, after] = varint(bytes, p)
          push(field, v)
          p = after
          break
        }
        case 1:
          push(field, bytes.subarray(p, p + 8))
          p += 8
          break
        case 2: {
          const [len, after] = varint(bytes, p)
          push(field, bytes.subarray(after, after + Number(len)))
          p = after + Number(len)
          break
        }
        case 5:
          push(field, bytes.subarray(p, p + 4))
          p += 4
          break
        default:
          // Groups (3 and 4) are deprecated and Anki emits none.
          return out
      }
    }
  } catch {
    // Whatever was read before the damage is still worth having.
  }
  return out
}

const utf8 = new TextDecoder()

export const protoString = (m: ProtoMessage, field: number, fallback = ''): string => {
  const v = m.get(field)?.[0]
  return v instanceof Uint8Array ? utf8.decode(v) : fallback
}

export const protoInt = (m: ProtoMessage, field: number, fallback = 0): number => {
  const v = m.get(field)?.[0]
  return typeof v === 'bigint' ? Number(v) : fallback
}

export const protoBool = (m: ProtoMessage, field: number): boolean => protoInt(m, field) !== 0

export const protoBytes = (m: ProtoMessage, field: number): Uint8Array[] =>
  (m.get(field) ?? []).filter((v): v is Uint8Array => v instanceof Uint8Array)

export const protoSub = (m: ProtoMessage, field: number): ProtoMessage[] =>
  protoBytes(m, field).map(decodeProto)
