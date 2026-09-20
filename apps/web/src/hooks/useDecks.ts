import { useCallback, useEffect, useState } from 'react'
import * as repo from '@/db/repo'
import { collectionReady } from '@/db/boot'

/**
 * The deck tree, loaded once per screen that needs it.
 *
 * Every page used to receive this as a prop from `App`, which worked while
 * there were four screens and one owner. With a router each page is mounted
 * independently, so the query moves to whoever needs it — one recursive CTE,
 * and the leaf pages stop depending on a parent they no longer have.
 *
 * Opening and seeding stays in `db/boot`, once per page load. Doing it here
 * would repeat the whole migration-and-seed path on every navigation.
 *
 * Two screens now hold the tree at once — the shell's Create menu and whatever
 * page is under it — so a deck made from the shell has to reach the list
 * beneath it. `refreshDecks()` is the whole mechanism: a set of listeners and a
 * loop. A store would be the same thing with a library around it.
 */
const listeners = new Set<() => void>()

/** Re-run every mounted `useDecks`. Call after anything writes to `decks`. */
export function refreshDecks(): void {
  for (const listener of listeners) listener()
}

export function useDecks() {
  const [decks, setDecks] = useState<repo.DeckRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      await collectionReady
      setDecks(await repo.deckTree())
      setError(null)
    } catch (e) {
      // A dead database must never look like an empty collection.
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => void reload(), [reload])

  useEffect(() => {
    const listener = () => void reload()
    listeners.add(listener)
    return () => void listeners.delete(listener)
  }, [reload])

  return { decks, error, reload }
}
