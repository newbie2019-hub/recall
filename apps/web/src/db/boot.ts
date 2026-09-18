import * as repo from './repo'

/**
 * Open and seed the collection exactly once per page load.
 *
 * A module-level promise rather than a call inside a hook: with a router every
 * screen mounts independently, and a hook would run the migration-and-seed path
 * again on each navigation. That is wasted work at best, and at worst it is four
 * screens racing the same `INSERT`s through one worker.
 *
 * Everything that reads the collection awaits this first, so no screen can query
 * a database that has not finished opening and render "no decks yet" at it.
 */
export const collectionReady: Promise<void> = repo.seedIfEmpty()
