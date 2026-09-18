/**
 * Note type management (CARDS.md §7). These are the operations that can detach
 * a field from its content across a whole collection, so each one is pinned.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addField, builtinNoteType, defaultFieldMap, mapFields, moveField, removeField,
  renameField, renameFieldRefs, type NoteType,
} from './notetypes.ts'
import { generatedOrds } from './template.ts'

const type = (over: Partial<NoteType> = {}): NoteType => ({
  id: 't', name: 'T', kind: 'standard', css: '',
  fields: ['Front', 'Back', 'Extra'],
  templates: [{ name: 'Card 1', qfmt: '{{Front}}', afmt: '{{FrontSide}}{{Back}}' }],
  sortField: 0,
  ...over,
})

test('renaming a field follows it into every template form it can take', () => {
  const t = renameFieldRefs(
    '{{Front}} {{#Front}}x{{/Front}} {{^Front}}y{{/Front}} {{text:Front}} {{cloze:hint:Front}}' +
    ' {{FrontSide}} {{Frontal}} {{type:Front}}',
    'Front', 'Term',
  )
  assert.equal(
    t,
    '{{Term}} {{#Term}}x{{/Term}} {{^Term}}y{{/Term}} {{text:Term}} {{cloze:hint:Term}}' +
    ' {{FrontSide}} {{Frontal}} {{type:Term}}',
  )
})

test('a rename moves the field, its templates and the occlusion ord field', () => {
  const nt = renameField(
    type({ kind: 'occlusion', ordField: 'Front', templates: [{ name: 'c', qfmt: '{{occlusion:Front}}', afmt: '' }] }),
    'Front', 'Shapes',
  )
  assert.deepEqual(nt.fields, ['Shapes', 'Back', 'Extra'])
  assert.equal(nt.ordField, 'Shapes')
  assert.equal(nt.templates[0]!.qfmt, '{{occlusion:Shapes}}')
  assert.throws(() => renameField(nt, 'Back', 'Extra'), /already a field/)
})

test('removing a field drags the sort field back with it, and never below zero', () => {
  const nt = removeField(type({ sortField: 2 }), 'Front')
  assert.deepEqual(nt.fields, ['Back', 'Extra'])
  assert.equal(nt.sortField, 1)
  // Removing the sorted field itself lands on something that exists.
  assert.equal(removeField(type({ sortField: 0 }), 'Front').sortField, 0)
  assert.throws(() => removeField(type({ fields: ['Only'] }), 'Only'), /at least one/)
  // Templates keep the dangling reference on purpose: it renders empty, which
  // is Anki's behaviour and visible, rather than a silent rewrite.
  assert.equal(nt.templates[0]!.qfmt, '{{Front}}')
})

test('moving a field keeps the sort field pointing at the same field', () => {
  const nt = type({ sortField: 2 })
  assert.deepEqual(moveField(nt, 'Extra', 0).fields, ['Extra', 'Front', 'Back'])
  assert.equal(moveField(nt, 'Extra', 0).sortField, 0, 'the sorted field moved with it')
  assert.equal(moveField(nt, 'Front', 2).sortField, 1, 'everything after it shifted down')
  assert.equal(moveField(type({ sortField: 0 }), 'Extra', 1).sortField, 0, 'untouched fields stay')
  assert.deepEqual(moveField(nt, 'Front', 99).fields, ['Back', 'Extra', 'Front'])

  const cfg = type({ fieldConfig: [{ sticky: true }, {}, { rtl: true }] })
  assert.deepEqual(moveField(cfg, 'Extra', 0).fieldConfig, [{ rtl: true }, { sticky: true }, {}])
})

test('adding a field appends it and leaves the existing cards alone', () => {
  const nt = addField(type(), 'Source')
  assert.deepEqual(nt.fields, ['Front', 'Back', 'Extra', 'Source'])
  assert.deepEqual(
    generatedOrds(nt, { Front: 'q', Back: 'a', Extra: '', Source: '' }),
    generatedOrds(type(), { Front: 'q', Back: 'a', Extra: '' }),
  )
  assert.throws(() => addField(nt, 'Back'), /already a field/)
})

test('the default field map prefers the same name, then the same position', () => {
  const basic = builtinNoteType('basic')!
  const renamed = type({ fields: ['Term', 'Back'] })
  assert.deepEqual(defaultFieldMap(basic, renamed), { Term: 'Front', Back: 'Back' })
  // Nothing at that position and no name match means an empty box, never a guess.
  assert.deepEqual(defaultFieldMap(basic, type({ fields: ['A', 'B', 'C'] })),
    { A: 'Front', B: 'Back', C: null })
})

test('mapping fields fills only what the map names', () => {
  const to = type({ fields: ['Term', 'Definition'] })
  const mapped = mapFields(to, { Front: 'mitral', Back: 'a valve' }, { Term: 'Front', Definition: null })
  assert.deepEqual(mapped, { Term: 'mitral', Definition: '' })
  // Every target field is present, so a note never carries keys its type lost.
  assert.deepEqual(Object.keys(mapFields(to, { Front: 'x', Stale: 'y' }, {})), ['Term', 'Definition'])
})
