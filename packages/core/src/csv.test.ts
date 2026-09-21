/**
 * The parser is the whole risk here. Everything downstream trusts that a field
 * containing a comma, a quote or a newline came back as one field — and every
 * one of those is in the first file anybody exports from a flashcard app.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  guessMapping, looksLikeHeader, parseCsv, sniffDelimiter, toCsv, toCsvRow, toNotes,
} from './csv.ts'

test('a plain file is rows of cells', () => {
  assert.deepEqual(parseCsv('a,b\nc,d'), [['a', 'b'], ['c', 'd']])
})

test('a quoted field keeps its delimiter, quotes and newlines', () => {
  assert.deepEqual(
    parseCsv('"Smith, John",x\n"say ""this""",y\n"two\nlines",z'),
    [['Smith, John', 'x'], ['say "this"', 'y'], ['two\nlines', 'z']],
  )
})

test('CRLF and a trailing newline do not invent a row', () => {
  assert.deepEqual(parseCsv('a,b\r\nc,d\r\n'), [['a', 'b'], ['c', 'd']])
})

test('an unterminated quote runs to the end rather than throwing', () => {
  // Somebody else's export from a tool neither of us has seen. The import
  // screen can show what we made of it; an exception shows nothing.
  assert.deepEqual(parseCsv('a,"unclosed\nb,c'), [['a', 'unclosed\nb,c']])
})

test('Excel’s byte-order mark does not end up inside the first header', () => {
  // Otherwise "Front" never matches a field named Front, by one invisible
  // character, and the whole mapping silently comes back empty.
  assert.deepEqual(parseCsv('﻿Front,Back\na,b'), [['Front', 'Back'], ['a', 'b']])
})

test('tabs and semicolons are sniffed, and quotes do not fool the count', () => {
  assert.equal(sniffDelimiter('Front\tBack\na\tb'), '\t')
  assert.equal(sniffDelimiter('Front;Back\na;b'), ';')
  // One real tab, and a comma that only lives inside a quoted field.
  assert.equal(sniffDelimiter('"Smith, John"\tx'), '\t')
  // Nothing at all: one column, and comma is the harmless default.
  assert.equal(sniffDelimiter('justonecolumn'), ',')
})

test('a row survives a round trip through the writer', () => {
  const row = ['a,b', 'say "this"', 'two\nlines', 'plain']
  assert.deepEqual(parseCsv(toCsvRow(row)), [row])
})

test('the writer quotes only what needs it', () => {
  assert.equal(toCsvRow(['plain', 'a,b']), 'plain,"a,b"')
  assert.equal(toCsv([['a'], ['b']]), 'a\r\nb')
})

test('a header is recognised only when it names fields and looks like one', () => {
  assert.equal(looksLikeHeader(['Front', 'Back'], ['Front', 'Back']), true)
  assert.equal(looksLikeHeader(['front', 'back'], ['Front', 'Back']), true, 'case does not matter')
  // A card whose first cell happens to be the word Front, but whose second is
  // a paragraph. Treating it as a header would eat the first note.
  assert.equal(
    looksLikeHeader(['Front', 'x'.repeat(80)], ['Front', 'Back']),
    false,
  )
  assert.equal(looksLikeHeader(['mitral', 'bicuspid'], ['Front', 'Back']), false)
})

test('with a header, columns map by name and in any order', () => {
  const rows = parseCsv('Back,Tags,Front\ncor,anatomy thorax,heart')
  const m = guessMapping(rows, ['Front', 'Back'])
  assert.deepEqual(m.fields, ['Back', null, 'Front'])
  assert.equal(m.tagColumn, 1)
  assert.equal(m.hasHeader, true)

  assert.deepEqual(toNotes(rows, m), [
    { fields: { Back: 'cor', Front: 'heart' }, tags: ['anatomy', 'thorax'], deck: null },
  ])
})

test('without a header, columns are taken in order', () => {
  const rows = parseCsv('heart,cor')
  const m = guessMapping(rows, ['Front', 'Back'])
  assert.equal(m.hasHeader, false)
  assert.deepEqual(toNotes(rows, m), [
    { fields: { Front: 'heart', Back: 'cor' }, tags: [], deck: null },
  ])
})

test('extra columns are ignored rather than crammed into the last field', () => {
  const rows = parseCsv('heart,cor,extra,more')
  const m = guessMapping(rows, ['Front', 'Back'])
  assert.deepEqual(m.fields, ['Front', 'Back', null, null])
})

test('a deck column routes each row, and tags split on comma too', () => {
  const rows = parseCsv('Front,Back,Deck,Tags\nheart,cor,Anatomy::Thorax,"a,b"')
  const m = guessMapping(rows, ['Front', 'Back'])
  assert.deepEqual(toNotes(rows, m), [
    { fields: { Front: 'heart', Back: 'cor' }, tags: ['a', 'b'], deck: 'Anatomy::Thorax' },
  ])
})

test('blank rows are dropped, so a spreadsheet’s trailing lines are not cards', () => {
  const rows = parseCsv('Front,Back\nheart,cor\n,\n  ,  ')
  const m = guessMapping(rows, ['Front', 'Back'])
  assert.equal(toNotes(rows, m).length, 1)
})
