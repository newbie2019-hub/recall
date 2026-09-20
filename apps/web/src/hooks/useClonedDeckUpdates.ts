import { useEffect, useState } from 'react'
import { collectionReady } from '@/db/boot'
import { clonedDecks } from '@/db/queries/marketplace'
import { listingUpdates, updateAvailable } from '@/lib/marketplace'

export interface DeckUpdate {
  listingId: string
  /** The version the publisher has now. The local deck holds an older one. */
  latestVersion: number
}

/**
 * Which cloned decks have a newer version upstream, keyed by deck id.
 *
 * The offer has to appear where the decks are. Until now it only existed on the
 * listing page, which means the only way to learn that a deck you study every
 * day had been updated was to go looking for the page you cloned it from —
 * "update available" that nobody is told about is a feature nobody has.
 *
 * It is one request for the whole collection, not one per deck, and it fails
 * silently: this is an *offer*, and an offline collection must not grow an error
 * banner because a nicety could not be checked. Nothing here writes anything —
 * applying an update is always the person's click, on a screen that says what it
 * will do (PHASES §8).
 */
export function useClonedDeckUpdates(): Map<string, DeckUpdate> {
  const [updates, setUpdates] = useState<Map<string, DeckUpdate>>(new Map())

  useEffect(() => {
    let cancelled = false

    void (async () => {
      await collectionReady
      const clones = await clonedDecks()
      if (cancelled || !clones.length) return

      const latest = await listingUpdates([
        ...new Set(clones.map((d) => d.source_listing_id)),
      ]).catch(() => new Map<string, number>())

      if (cancelled) return

      const found = new Map<string, DeckUpdate>()
      for (const deck of clones) {
        const latestVersion = latest.get(deck.source_listing_id)
        if (latestVersion === undefined) continue
        if (!updateAvailable(deck, { latest_version: latestVersion })) continue
        found.set(deck.id, { listingId: deck.source_listing_id, latestVersion })
      }
      setUpdates(found)
    })()

    return () => {
      cancelled = true
    }
  }, [])

  return updates
}
