/*
 * The offline shell. Hand-written, not Workbox.
 *
 * Workbox exists to precache a build's hashed files from a generated manifest.
 * Vite already hashes every asset it emits, which is the same guarantee from
 * the other end: a URL under /assets/ can never change content, so cache-first
 * on it needs no manifest, no revision list and no build step. That is the
 * whole of vite-plugin-pwa's value here, and it costs ~40 lines instead of
 * workbox-build's dependency tree (PHASES.md Phase 5 asks for "Workbox"; this
 * is what it asked Workbox *for*).
 *
 * What is deliberately not here:
 *
 * - **The data.** The collection lives in OPFS and is read by a dedicated
 *   worker, never over HTTP. There is nothing for a cache to hold.
 * - **The sync queue.** Background Sync would need the bearer token inside the
 *   service worker — copied out of the page, kept in a second place, and
 *   revoked in two places when a device is revoked (PLAN.md §2.6). P5-sync's
 *   in-page loop already retries on reconnect, which is what Background Sync
 *   buys, and a browser that never reopens the tab has no reviews to push.
 * - **Media.** `mediaUrl()` builds a blob: URL from the local media table;
 *   media does not cross the network on the web client at all today. When the
 *   `/api/v1/media/<sha>` download lands, it is content-addressed and belongs
 *   in IMMUTABLE below — one line, because a sha256 URL can never go stale.
 */
const CACHE = 'recall-shell-v1'

// The one URL whose content *does* change per deploy, so it is fetched fresh
// and only falls back to the cache. Everything else is hashed.
const SHELL = '/index.html'

// ponytail: hashed assets and the 856 kB sqlite wasm are runtime-cached on
// first visit, not precached. The app cannot start without either, so the first
// load fetches both anyway — precaching would move the same bytes to the same
// visit and buy a build-time manifest to maintain. Precache the day a cold
// second visit measurably beats a cold first one.
const IMMUTABLE = /^\/assets\/|\.wasm$/

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.add(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  // Never the API: those carry a bearer token and an answer that is only true
  // for one moment. A stale sync page is worse than no sync page.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin
      || url.pathname.startsWith('/api/')) return

  if (event.request.mode === 'navigate') {
    // Every route is index.html — a router path must resolve offline too.
    event.respondWith(
      fetch(event.request).catch(async () =>
        // `respondWith` rejects on undefined, which shows the browser's own
        // offline page instead of ours — so a cache miss has to be a Response.
        (await caches.match(SHELL)) ?? new Response('Offline', { status: 503 }),
      ),
    )
    return
  }

  if (!IMMUTABLE.test(url.pathname)) return

  event.respondWith((async () => {
    const hit = await caches.match(event.request)
    if (hit) return hit

    const res = await fetch(event.request)

    // **Awaited, not fired and forgotten.** The original wrote the cache in a
    // dangling `.then()` and the write never happened: a service worker is
    // killed the moment the events it is handling settle, so a `put` nobody is
    // waiting on is one the browser is free to drop — and it did, for every
    // asset, on every load. The cache held `index.html` and nothing else,
    // while the app still *appeared* to work offline because Chrome's own disk
    // cache happened to have the rest. That is evictable and was never the
    // plan; the e2e clears it before checking, which is what exposed this.
    //
    // Awaiting the put keeps `respondWith` pending, which is what keeps the
    // worker alive. It costs one cache write on the first sight of each asset
    // and nothing afterwards, because a hit returns above without fetching.
    // (`waitUntil` here instead is the textbook answer and does not survive an
    // `await` in Chrome — the event is no longer dispatching by then.)
    if (res.ok) {
      const copy = res.clone()
      const cache = await caches.open(CACHE)
      await cache.put(event.request, copy)
    }
    return res
  })())
})
