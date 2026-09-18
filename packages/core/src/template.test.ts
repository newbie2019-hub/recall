/**
 * Golden fixtures for the template engine, one per stock Anki note type plus
 * the template language itself. Written before the renderer, on purpose — this
 * is the unit every imported deck in Phase 3 lands on.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BUILTIN_NOTE_TYPES, builtinNoteType, type NoteType } from './notetypes.ts'
import { generatedOrds, parse, renderCard, renderSide, typeFieldOf } from './template.ts'
import { clozeAnswer, clozeOrds, renderCloze } from './cloze.ts'
import { typeAnswerHtml } from './diff.ts'
import { renderMath } from './math.ts'
import { occlusionOrds, parseOcclusion } from './occlusion.ts'

const nt = (id: string): NoteType => {
  const t = builtinNoteType(id)
  assert.ok(t, `no built-in note type ${id}`)
  return t
}

// ── the six stock types ───────────────────────────────────────────────────

test('Basic: one card, front to back', () => {
  const type = nt('basic')
  const fields = { Front: 'Which valve?', Back: 'Mitral' }
  assert.deepEqual(generatedOrds(type, fields), [0])
  const card = renderCard(type, fields, 0)
  assert.equal(card.front, 'Which valve?')
  assert.equal(card.back, 'Which valve?\n<hr id="answer">\nMitral')
})

test('Basic (and reversed): two cards, the second swaps sides', () => {
  const type = nt('basic-reversed')
  const fields = { Front: 'Mitral valve', Back: 'Two cusps' }
  assert.deepEqual(generatedOrds(type, fields), [0, 1])
  assert.equal(renderSide(type, fields, 1, 'front'), 'Two cusps')
  assert.equal(renderCard(type, fields, 1).back, 'Two cusps\n<hr id="answer">\nMitral valve')
})

test('Basic (optional reversed): card 2 exists only while the field is filled', () => {
  const type = nt('basic-optional-reversed')
  const off = { Front: 'Q', Back: 'A', 'Add Reverse': '' }
  const on = { Front: 'Q', Back: 'A', 'Add Reverse': 'y' }
  assert.deepEqual(generatedOrds(type, off), [0])
  assert.deepEqual(generatedOrds(type, on), [0, 1])
  assert.equal(renderSide(type, on, 1, 'front'), 'A')
  assert.equal(renderSide(type, off, 1, 'front'), '')
})

test('Basic (type in the answer): slot on the front, diff on the back', () => {
  const type = nt('basic-type-in')
  const fields = { Front: 'Spell it', Back: 'mitral' }
  assert.equal(typeFieldOf(type, 0), 'Back')
  const card = renderCard(type, fields, 0, { typed: 'mitrl' })
  assert.match(card.front, /<div class="type-slot"><\/div>/)
  assert.match(card.back, /typed-missing">a</)
  assert.match(renderCard(type, fields, 0, { typed: 'mitral' }).back, /typed-ok/)
})

test('Cloze: one card per distinct deletion', () => {
  const type = nt('cloze')
  const fields = { Text: 'The {{c1::mitral}} valve has {{c2::two}} cusps.', 'Back Extra': '' }
  assert.deepEqual(generatedOrds(type, fields), [0, 1])
  assert.equal(
    renderSide(type, fields, 0, 'front'),
    'The <span class="cloze-blank">[...]</span> valve has two cusps.',
  )
  assert.equal(
    renderSide(type, fields, 0, 'back'),
    'The <span class="cloze">mitral</span> valve has two cusps.',
  )
  // The other deletion stays plain while it is not the one being asked.
  assert.match(renderSide(type, fields, 1, 'front'), /The mitral valve has <span class="cloze-blank">/)
})

test('Image Occlusion: one card per shape, overlay rebuilt on both sides', () => {
  const type = nt('image-occlusion')
  const fields = {
    Occlusion: JSON.stringify({
      mode: 'all',
      shapes: [
        { kind: 'rect', ord: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        { kind: 'ellipse', ord: 1, x: 0.5, y: 0.5, w: 0.2, h: 0.1 },
      ],
    }),
    Image: '<img src="media/abc">',
    Header: 'Cardiac chambers',
    'Back Extra': '',
    Comments: '',
  }
  assert.deepEqual(generatedOrds(type, fields), [0, 1])
  const card = renderCard(type, fields, 0)
  assert.match(card.front, /io-header/)
  assert.match(card.front, /<img src="media\/abc">/)
  assert.match(card.front, /class="io-asked"/)
  assert.match(card.back, /class="io-revealed"/)
  // Hide-all keeps the other masks up; hide-one does not draw them at all.
  assert.match(card.front, /class="io-mask"/)
  const one = { ...fields, Occlusion: fields.Occlusion.replace('"all"', '"one"') }
  assert.doesNotMatch(renderSide(type, one, 0, 'front'), /io-mask/)
})

test('cloze ordinals come from every field, are sparse, and ignore c0', () => {
  const type = nt('cloze')
  // Anki's `cloze_numbers_in_note` iterates the whole note, so a deletion in
  // Back Extra is a real card.
  assert.deepEqual(generatedOrds(type, { Text: '{{c1::a}}', 'Back Extra': '{{c2::b}}' }), [0, 1])

  // Gaps are preserved: renumbering c3 to ord 1 would hand it c2's history.
  assert.deepEqual(clozeOrds('{{c1::a}} and {{c3::b}}'), [0, 2])

  // c0 is not legal in Anki; dropping it keeps ords non-negative, and a
  // negative ord is a card id that could never be found in the log again.
  assert.deepEqual(clozeOrds('{{c0::x}}'), [])
  assert.deepEqual(generatedOrds(type, { Text: '{{c0::x}}', 'Back Extra': '' }), [])
})

test('occlusion shapes sharing an ordinal are one card that reveals both', () => {
  const shapes = (...o: number[]) =>
    JSON.stringify({ mode: 'all', shapes: o.map((ord, i) => ({ kind: 'rect', ord, x: i / 10, y: 0, w: 0.1, h: 0.1 })) })
  const type = nt('image-occlusion')
  const fields = { Occlusion: shapes(0, 0, 1), Image: '<img src="media/x">', Header: '', 'Back Extra': '', Comments: '' }
  assert.deepEqual(generatedOrds(type, fields), [0, 1])
  // Both of card 1's shapes are asked, not one asked and one masked.
  const front = renderSide(type, fields, 0, 'front')
  assert.equal(front.match(/io-asked/g)?.length, 2)
  assert.equal(front.match(/io-mask/g)?.length, 1)
})

// ── the template language ─────────────────────────────────────────────────

test('conditionals: #Field renders when filled, ^Field when blank', () => {
  const type = nt('basic')
  const t = '{{#Back}}has{{/Back}}{{^Back}}none{{/Back}}'
  assert.equal(renderSide({ ...type, templates: [{ name: 'x', qfmt: t, afmt: '' }] }, { Back: 'b' }, 0, 'front'), 'has')
  assert.equal(renderSide({ ...type, templates: [{ name: 'x', qfmt: t, afmt: '' }] }, { Back: '' }, 0, 'front'), 'none')
  // A field of markup with no text is empty, the same as Anki treats it.
  assert.equal(renderSide({ ...type, templates: [{ name: 'x', qfmt: t, afmt: '' }] }, { Back: '<br>' }, 0, 'front'), 'none')
})

test('a field holding only media is not empty', () => {
  const type = nt('basic')
  const t = '{{#Back}}has{{/Back}}{{^Back}}none{{/Back}}'
  const one = (Back: string) =>
    renderSide({ ...type, templates: [{ name: 'x', qfmt: t, afmt: '' }] }, { Back }, 0, 'front')

  // Anki's rule: only whitespace and the tags an editor leaves behind are
  // nothing. An image is content, so the conditional fires and the card exists.
  assert.equal(one('<img src="media/abc">'), 'has')
  assert.equal(one('<div><br></div>'), 'none')

  assert.deepEqual(generatedOrds(type, { Front: '<img src="media/abc">', Back: 'x' }), [0])
  assert.deepEqual(generatedOrds(type, { Front: '<br>', Back: 'x' }), [])
  assert.deepEqual(
    generatedOrds(nt('basic-optional-reversed'), { Front: 'q', Back: 'a', 'Add Reverse': '<img src="media/x">' }),
    [0, 1],
  )
})

test('filters: text strips markup, hint is a native disclosure, unknown passes through', () => {
  const one = (qfmt: string, fields: Record<string, string>) =>
    renderSide({ ...nt('basic'), templates: [{ name: 'x', qfmt, afmt: '' }] }, fields, 0, 'front')

  assert.equal(one('{{text:Front}}', { Front: '<b>bold</b>&amp;' }), 'bold&')
  assert.equal(one('{{hint:Back}}', { Back: 'shh' }), '<details class="hint"><summary>Back</summary>shh</details>')
  assert.equal(one('{{hint:Back}}', { Back: '' }), '')
  assert.equal(one('{{furigana:Front}}', { Front: 'kanji[kana]' }), 'kanji[kana]')
})

test('conditionals work on special fields, and filters apply right to left', () => {
  const one = (qfmt: string, opts = {}) =>
    renderSide({ ...nt('basic'), templates: [{ name: 'x', qfmt, afmt: '' }] }, { Front: 'f' }, 0, 'front', opts)

  assert.equal(one('{{#Tags}}{{Tags}}{{/Tags}}{{^Tags}}untagged{{/Tags}}', { tags: ['heart'] }), 'heart')
  assert.equal(one('{{#Tags}}x{{/Tags}}{{^Tags}}untagged{{/Tags}}'), 'untagged')

  // `{{text:hint:Back}}` must build the disclosure first, then strip it — the
  // filter nearest the field name runs first, as in Anki.
  const chained = renderSide(
    { ...nt('basic'), templates: [{ name: 'x', qfmt: '{{text:hint:Back}}', afmt: '' }] },
    { Front: 'f', Back: 'shh' }, 0, 'front',
  )
  assert.equal(chained, 'Backshh')
})

test('cloze conditionals fire only on their own card', () => {
  const type: NoteType = {
    ...nt('cloze'),
    templates: [{
      name: 'Cloze',
      qfmt: '{{cloze:Text}}',
      afmt: '{{cloze:Text}}{{#c2}}<i>only on card 2</i>{{/c2}}{{^c1}}<b>not card 1</b>{{/c1}}',
    }],
  }
  const fields = { Text: '{{c1::a}} then {{c2::b}}', 'Back Extra': '' }
  const back = (ord: number) => renderSide(type, fields, ord, 'back')

  assert.doesNotMatch(back(0), /only on card 2/)
  assert.match(back(1), /only on card 2/)
  assert.doesNotMatch(back(0), /not card 1/)
  assert.match(back(1), /not card 1/)

  // `c1` is not a section name in a non-cloze type, so it falls through to the
  // ordinary emptiness test and renders nothing.
  assert.equal(
    renderSide({ ...nt('basic'), templates: [{ name: 'x', qfmt: '{{#c1}}y{{/c1}}', afmt: '' }] },
      { Front: 'f' }, 0, 'front'),
    '',
  )
})

test('CardFlag, and type:nc: grades without accents', () => {
  const flag = (n: number) =>
    renderSide({ ...nt('basic'), templates: [{ name: 'x', qfmt: '{{CardFlag}}', afmt: '' }] },
      { Front: 'f' }, 0, 'front', { flag: n })
  assert.equal(flag(0), '')
  assert.equal(flag(3), 'flag3')

  const type: NoteType = {
    ...nt('basic'),
    templates: [{ name: 'x', qfmt: '{{type:nc:Back}}', afmt: '{{type:nc:Back}}' }],
  }
  assert.equal(typeFieldOf(type, 0), 'Back')
  // "ecoute" must grade as correct against "écoute".
  assert.match(renderSide(type, { Front: 'f', Back: 'écoute' }, 0, 'back', { typed: 'ecoute' }), /typed-ok/)
  assert.doesNotMatch(renderSide(type, { Front: 'f', Back: 'écoute' }, 0, 'back', { typed: 'ecout' }), /typed-ok/)
})

test('specials: FrontSide, Tags, Type, Deck, Card', () => {
  const type: NoteType = {
    ...nt('basic'),
    templates: [{ name: 'Only', qfmt: '{{Front}}', afmt: '{{FrontSide}}|{{Tags}}|{{Type}}|{{Deck}}|{{Subdeck}}|{{Card}}' }],
  }
  const card = renderCard(type, { Front: 'Q' }, 0, {
    tags: ['valves', 'exam'], deck: 'Anatomy::Heart', subdeck: 'Heart',
  })
  assert.equal(card.back, 'Q|valves exam|Basic|Anatomy::Heart|Heart|Only')
})

test('a broken template does not take the deck down with it', () => {
  assert.deepEqual(parse('{{#A}}x').length, 1)
  assert.equal(
    renderSide({ ...nt('basic'), templates: [{ name: 'x', qfmt: '{{Front}}{{/Nope}}!', afmt: '' }] }, { Front: 'a' }, 0, 'front'),
    'a!',
  )
})

test('every built-in generates the cards its name promises', () => {
  const expected: Record<string, number> = {
    basic: 1, 'basic-reversed': 2, 'basic-optional-reversed': 2, 'basic-type-in': 1,
    cloze: 2, 'image-occlusion': 2,
  }
  const filled: Record<string, string> = {
    Front: 'f', Back: 'b', 'Add Reverse': 'y',
    Text: '{{c1::a}} and {{c2::b}}', 'Back Extra': '',
    Occlusion: '[{"kind":"rect","ord":0,"x":0,"y":0,"w":1,"h":1},{"kind":"rect","ord":1,"x":0,"y":0,"w":1,"h":1}]',
    Image: '<img src="media/x">', Header: '', Comments: '',
  }
  for (const type of BUILTIN_NOTE_TYPES)
    assert.equal(generatedOrds(type, filled).length, expected[type.id], type.id)
})

// ── cloze parsing ─────────────────────────────────────────────────────────

test('cloze nesting: the outer blank swallows the inner one', () => {
  const src = '{{c1::the {{c2::mitral}} valve}}'
  assert.deepEqual(clozeOrds(src), [0, 1])
  assert.equal(renderCloze(src, 0, 'front'), '<span class="cloze-blank">[...]</span>')
  assert.equal(renderCloze(src, 1, 'front'), 'the <span class="cloze-blank">[...]</span> valve')
  assert.equal(renderCloze(src, 0, 'back'), '<span class="cloze">the mitral valve</span>')
  assert.equal(clozeAnswer(src, 0), 'the mitral valve')
})

test('cloze hints replace the ellipsis', () => {
  assert.equal(
    renderCloze('{{c1::mitral::which valve}}', 0, 'front'),
    '<span class="cloze-blank">[which valve]</span>',
  )
})

test('cloze survives three levels and an unclosed deletion', () => {
  assert.deepEqual(clozeOrds('{{c1::a {{c2::b {{c3::c}}}}}}'), [0, 1, 2])
  assert.equal(renderCloze('{{c1::a {{c2::b {{c3::c}}}}}}', 2, 'front'), 'a b <span class="cloze-blank">[...]</span>')
  assert.deepEqual(clozeOrds('{{c1::unterminated'), [0])
})

test('text with braces but no deletion is left alone', () => {
  assert.deepEqual(clozeOrds('f(x) = {1, 2}'), [])
  assert.equal(renderCloze('f(x) = {1, 2}', 0, 'front'), 'f(x) = {1, 2}')
})

// ── typed answers, maths, occlusion data ──────────────────────────────────

test('type diff marks inserted and missing characters separately', () => {
  const html = typeAnswerHtml('sinoatrial', 'sinoartrial')
  assert.match(html, /typed-bad/)
  assert.match(html, /class="typed-expected"/)
  assert.match(typeAnswerHtml('a', 'a'), /typed-ok/)
  // HTML in the expected field is compared as text, not markup.
  assert.match(typeAnswerHtml('<b>mitral</b>', 'mitral'), /typed-ok/)
})

test('maths: all four Anki delimiter styles, and never inside a tag', () => {
  const show = (tex: string, display: boolean) => `[${display ? 'D' : 'I'}:${tex}]`
  assert.equal(renderMath('x \\(a^2\\) y', show), 'x [I:a^2] y')
  assert.equal(renderMath('\\[\\frac12\\]', show), '[D:\\frac12]')
  assert.equal(renderMath('[$]a[/$] [$$]b[/$$]', show), '[I:a] [D:b]')
  assert.equal(renderMath('[latex]c[/latex]', show), '[D:c]')
  assert.equal(renderMath('<img alt="\\(x\\)">', show), '<img alt="\\(x\\)">')
  // Entities survive the round trip into TeX.
  assert.equal(renderMath('\\(a &lt; b\\)', show), '[I:a < b]')
})

test('occlusion data is parsed tolerantly', () => {
  assert.deepEqual(parseOcclusion('').shapes, [])
  assert.deepEqual(parseOcclusion('not json').shapes, [])
  assert.equal(parseOcclusion('[{"kind":"rect","ord":0,"x":0,"y":0,"w":1,"h":1}]').mode, 'all')
  const r = (ord: number) => `{"kind":"rect","ord":${ord},"x":0,"y":0,"w":0.2,"h":0.2}`
  assert.deepEqual(occlusionOrds(`[${r(2)},${r(0)},${r(2)}]`), [0, 2])

  // Junk is dropped rather than turned into a NaN ordinal, which would be a
  // card whose history could never be found in the review log again.
  assert.deepEqual(
    occlusionOrds(`[${r(0)},{"kind":"rect"},{"kind":"blob","ord":1},{"kind":"rect","ord":"x","x":0,"y":0,"w":1,"h":1}]`),
    [0],
  )
})
