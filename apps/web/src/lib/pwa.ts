/**
 * Turning the app into something that opens offline and installs.
 *
 * Two things, both one-way: the service worker in `public/sw.js` (which says
 * what it caches and why), and the manifest that makes "Add to Home Screen"
 * offer this rather than a bookmark.
 *
 * Production only. In dev the module graph is hundreds of unhashed URLs that
 * change on every save, and a cache in front of that is a morning spent
 * wondering why an edit did nothing.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return

  // After load: registration competes with the first paint and the sqlite wasm
  // for bandwidth, and the shell is only needed on the *next* visit.
  addEventListener('load', () => {
    // A failed registration is not worth a broken launch — every screen works
    // online without it.
    void navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}

