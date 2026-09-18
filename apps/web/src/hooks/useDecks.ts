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
 */
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

  return { decks, error, reload }
}
