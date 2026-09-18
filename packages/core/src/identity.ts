/**
 * Note identity and the duplicate check. Pure, synchronous, no crypto — these
 * run in a worker, in Node and in React Native.
 */
import { stripHtml } from './html.ts'

/**
 * A note's GUID: minted once, never rewritten, carried through every export.
 *
 * This is what an importer matches on — same guid means "the same note, newer
 * content", which is how a shared deck ships v2 without duplicating everything
 * you already study. Anki uses base91 of a random int; any stable string round
 * -trips, so this is 16 hex characters from the platform CSPRNG. 64 bits is far
 * past the point where collision matters for a personal collection.
 */
export function newGuid(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Checksum of a note's first field, for the duplicate warning while adding.
 *
 * **Not Anki's `csum`**, which is SHA1-based and needs async crypto in a
 * browser. Nothing depends on the two agreeing: import matches on guid, and
 * this only ever compares our rows against each other. Phase 4's *exporter*
 * has to write a real Anki csum, and that is the one place the distinction
 * matters.
 *
 * FNV-1a, 32-bit, returned signed so SQLite stores it as a plain INTEGER.
 */
export function fieldChecksum(firstField: string): number {
  const text = stripHtml(firstField).replace(/\s+/g, ' ').trim()
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h | 0
}

/** The first field's value, in the note type's field order. */
export const firstFieldOf = (fieldNames: string[], fields: Record<string, string>) =>
  fields[fieldNames[0] ?? ''] ?? ''

// ── deck paths ────────────────────────────────────────────────────────────

/**
 * Anki has no deck tree — it has flat names with `::` separators, and a deck
 * called `Anatomy::Thorax` is a child of `Anatomy` only by convention. We store
 * a real `parent_id` tree, so import splits and export joins.
 *
 * Anki forbids `::` inside a single deck name, which is what makes the split
 * unambiguous. A name that arrives with empty components ("A::::B") is repaired
 * rather than rejected: dropping a deck on import is worse than renaming one.
 */
export const DECK_SEP = '::'

export const splitDeckPath = (path: string): string[] =>
  path.split(DECK_SEP).map((part) => part.trim()).filter(Boolean)

export const joinDeckPath = (parts: string[]): string => parts.join(DECK_SEP)

/** Strip the separator out of a name a user typed, so the tree stays honest. */
export const safeDeckName = (name: string): string =>
  name.replace(/::+/g, ' ').replace(/\s+/g, ' ').trim()
