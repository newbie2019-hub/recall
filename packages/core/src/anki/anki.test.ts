/**
 * The `.apkg` boundary: the container, the wire format inside it, and the two
 * rewrites every imported note goes through. Everything here is what a real
 * deck breaks on, so each case is one shape found in the wild.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crc32, readZip, unzip, zip } from '../zip.ts'
import { decodeProto, protoInt, protoString } from './proto.ts'
import { mediaNames, normaliseOcclusion, parseAnkiOcclusion, rewriteMedia } from './media.ts'
import { ankiCsum, modelsJson, stripMedia } from './write.ts'
import { readNoteTypes, type AnkiSelect } from './read.ts'
import { BUILTIN_NOTE_TYPES } from '../notetypes.ts'

const utf8 = new TextEncoder()

test('a zip survives a round trip, compressed and stored alike', async () => {
  const text = utf8.encode('mitral valve '.repeat(400))
  // Random bytes do not deflate, so this entry takes the stored path.
  const noisy = new Uint8Array(2048).map((_, i) => (i * 2654435761) % 256)
  const archive = await zip(new Map([
    ['collection.anki2', text],
    ['media', utf8.encode('{"0":"heart.png"}')],
    ['0', noisy],
  ]))

  const entries = unzip(archive)
  assert.deepEqual([...entries.keys()], ['collection.anki2', 'media', '0'])
  assert.deepEqual(await entries.get('collection.anki2')!.bytes(), text)
  assert.deepEqual(await entries.get('0')!.bytes(), noisy)
  assert.equal(new TextDecoder().decode((await readZip(archive, 'media'))!), '{"0":"heart.png"}')
  assert.equal(await readZip(archive, 'absent'), null)
  assert.ok(archive.length < text.length, 'the compressible entry actually compressed')
})

test('crc32 matches the published check value', () => {
  // The standard "check" vector for CRC-32/ISO-HDLC.
  assert.equal(crc32(utf8.encode('123456789')), 0xcbf43926)
  assert.equal(crc32(new Uint8Array()), 0)
})

test('protobuf reads the fields a schema 18 template config holds', () => {
  // field 1 (qfmt) = "{{Front}}", field 5 (target deck) = 300, varint > 127.
  const blob = new Uint8Array([
    0x0a, 0x09, ...utf8.encode('{{Front}}'),
    0x12, 0x02, ...utf8.encode('ab'),
    0x28, 0xac, 0x02,
  ])
  const m = decodeProto(blob)
  assert.equal(protoString(m, 1), '{{Front}}')
  assert.equal(protoString(m, 2), 'ab')
  assert.equal(protoInt(m, 5), 300)
  assert.equal(protoInt(m, 9, -1), -1, 'an absent field is absent, not zero')
  // A blob we cannot read costs its own template, never the whole import.
  assert.equal(decodeProto(new Uint8Array([0xff])).size, 0)
  assert.equal(decodeProto(null).size, 0)
})

test('media references are found and rewritten, and left alone when unknown', () => {
  const html =
    '<img src="heart%20left.png"> <img src=\'plain.jpg\'> <img src=bare.gif>' +
    ' [sound:beat.mp3] <img src="https://x.test/a.png"> <img src="data:image/png;base64,AA">'
  assert.deepEqual(mediaNames(html),
    ['heart left.png', 'plain.jpg', 'bare.gif', 'beat.mp3'])

  const out = rewriteMedia(html, (n) => (n === 'heart left.png' ? 'media/abc' : null))
  assert.match(out, /src="media\/abc"/)
  assert.match(out, /src='plain\.jpg'/, 'an unmapped name keeps its reference')
  assert.match(out, /src="https:\/\/x\.test\/a\.png"/, 'remote images are not ours')
  assert.match(out, /\[sound:beat\.mp3\]/)
  assert.match(rewriteMedia(html, () => 'media/z'), /\[sound:media\/z\]/)
})

test('Anki occlusion shapes map onto ours, centre-and-radius included', () => {
  const field =
    '{{c1::image-occlusion:rect:left=10:top=20:width=30:height=40:oi=1}}<br>' +
    '{{c2::image-occlusion:ellipse:left=50:top=60:rx=10:ry=5}}<br>' +
    '{{c3::image-occlusion:polygon:points=0,0 100,0 50,50}}'
  const occ = parseAnkiOcclusion(field)

  assert.equal(occ.mode, 'all', 'oi=1 means the other masks stay covered')
  assert.equal(occ.shapes.length, 3)
  // Anki counts deletions from 1 and we count ordinals from 0.
  assert.deepEqual(occ.shapes.map((s) => s.ord), [0, 1, 2])
  assert.deepEqual(occ.shapes[0], { kind: 'rect', ord: 0, x: 10, y: 20, w: 30, h: 40 })
  // Its ellipse is a centre and two radii; ours is a bounding box.
  assert.deepEqual(occ.shapes[1], { kind: 'ellipse', ord: 1, x: 40, y: 55, w: 20, h: 10 })

  const json = normaliseOcclusion(occ, 200, 100)!
  const parsed = JSON.parse(json)
  assert.deepEqual(parsed.shapes[0], { kind: 'rect', ord: 0, x: 0.05, y: 0.2, w: 0.15, h: 0.4 })
  assert.deepEqual(parsed.shapes[2].points, [[0, 0], [0.5, 0], [0.25, 0.5]])
  // Unmeasurable image: say so rather than write coordinates that are a guess.
  assert.equal(normaliseOcclusion(occ, 0, 100), null)
  assert.equal(normaliseOcclusion({ mode: 'one', shapes: [] }, 10, 10), null)
})

test("the exported checksum is Anki's, not ours", async () => {
  // SHA-1("mitral") starts 65ae4aae, and Anki keeps the first four bytes.
  assert.equal(await ankiCsum('mitral'), 0x65ae4aae)
  // It checksums the stripped sort field, so markup and media do not count.
  assert.equal(await ankiCsum('<b>mitral</b> [sound:x.mp3]'), await ankiCsum('mitral'))
  assert.equal(stripMedia('<div>a</div> [sound:b.mp3] [anki:tts]'), 'a')
})

test('a note type keeps its kind across an export and back', async () => {
  // The bug this guards: a simulation exported as cloze comes back as cloze,
  // generates no cards (it has no cloze markers), and its notes then vanish
  // from the *next* export — silently, because a note with no cards is not
  // wrong, it is just absent.
  const types = BUILTIN_NOTE_TYPES.map((nt, i) => ({ nt, mid: 1000 + i, overrides: [] }))
  const models = modelsJson(types, 1_700_000_000_000)

  const select = (async (sql: string) =>
    sql.includes('col') ? [{ models }] : []) as AnkiSelect
  const back = await readNoteTypes(select, 11)

  for (const { nt } of types) {
    const found = back.find((b) => b.noteType.name === nt.name)
    assert.equal(found?.noteType.kind, nt.kind, `${nt.name} came back as ${found?.noteType.kind}`)
  }
})
