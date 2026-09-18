/** Note identity and deck-path mapping — what Phase 4's importer matches on. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fieldChecksum, joinDeckPath, newGuid, safeDeckName, splitDeckPath } from './identity.ts'

test('guids are unique and stable in shape', () => {
  const seen = new Set(Array.from({ length: 500 }, newGuid))
  assert.equal(seen.size, 500)
  for (const g of seen) assert.match(g, /^[0-9a-f]{16}$/)
})

test('the duplicate checksum ignores markup and whitespace, not content', () => {
  assert.equal(fieldChecksum('<b>Mitral</b> valve'), fieldChecksum('Mitral  valve '))
  assert.notEqual(fieldChecksum('Mitral valve'), fieldChecksum('Tricuspid valve'))
  assert.equal(fieldChecksum(''), fieldChecksum('   '))
  // Must survive SQLite's INTEGER, so: a signed 32-bit value.
  for (const s of ['a', 'mitral', '<img src="media/x">', 'écoute'])
    assert.ok(Number.isSafeInteger(fieldChecksum(s)) && Math.abs(fieldChecksum(s)) <= 2 ** 31)
})

test('Anki deck paths round-trip through the tree', () => {
  assert.deepEqual(splitDeckPath('Anatomy::Thorax::Heart'), ['Anatomy', 'Thorax', 'Heart'])
  assert.equal(joinDeckPath(['Anatomy', 'Thorax', 'Heart']), 'Anatomy::Thorax::Heart')

  // Repair rather than reject: dropping a deck on import is worse than
  // quietly fixing a name nobody meant to type.
  assert.deepEqual(splitDeckPath('A::::B'), ['A', 'B'])
  assert.deepEqual(splitDeckPath('  Anatomy :: Thorax '), ['Anatomy', 'Thorax'])
  assert.deepEqual(splitDeckPath(''), [])

  // A name typed by a user cannot smuggle a separator into one tree node.
  assert.equal(safeDeckName('Heart::Valves'), 'Heart Valves')
  assert.equal(splitDeckPath(joinDeckPath(['A', safeDeckName('B::C')])).length, 2)
})
