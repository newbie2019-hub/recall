import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { ListingCard } from '@/components/marketplace/ListingCard'
import { useAuth } from '@/lib/auth'
import { listListings, type Listing } from '@/lib/marketplace'
import { paths } from './paths'

/**
 * Browse published decks. **Works signed out** — `/explore` is in
 * `PUBLIC_PATHS`, and that is the point: a shared deck link has to open for
 * someone who has never heard of this app, and Phase 12's universal links
 * resolve against these paths.
 *
 * Which also means this is the one screen where a server error is fatal to the
 * content: there is no local copy of somebody else's deck. It says so plainly
 * instead of rendering an empty grid that reads as "nothing published yet".
 */
export function MarketplacePage() {
  const { user } = useAuth()
  const [q, setQ] = useState('')
  const [listings, setListings] = useState<Listing[] | null>(null)
  const [cursor, setCursor] = useState<number | string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)

  // Debounced: typing "cardio" is six keystrokes and must not be six searches.
  // `attempt` is in the dependencies so that retrying re-runs a search whose
  // query has not changed — the only thing that changed is the network.
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      setListings(null)
      setError(null)
      void listListings({ q })
        .then((page) => {
          if (cancelled) return
          setListings(page.items)
          setCursor(page.next_cursor)
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e))
        })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [q, attempt])

  async function more() {
    setBusy(true)
    try {
      const next = await listListings({ q, cursor })
      setListings((current) => [...(current ?? []), ...next.items])
      setCursor(next.next_cursor)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl tracking-tight">Explore</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Decks people have published. Cloning one copies it into your collection —
            it is yours from that moment.
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link to={user ? paths.decks : paths.signIn}>{user ? 'Your decks' : 'Sign in'}</Link>
        </Button>
      </header>

      <div className="mb-6">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search decks and tags"
            aria-label="Search published decks"
            className="pl-9"
          />
        </div>
      </div>

      {error && (
        <div className="specimen-tag p-6">
          <h2 className="mb-1 text-base">Can't reach the marketplace</h2>
          <p className="text-sm text-muted-foreground">
            Published decks live on the server, so there is nothing to show offline.
            Your own cards are unaffected.
          </p>
          <p className="mt-2 font-mono text-xs text-eosin">{error}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => setAttempt((a) => a + 1)}>
            Try again
          </Button>
        </div>
      )}

      {!error && !listings && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-48 w-full" />
          ))}
        </div>
      )}

      {listings && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {listings.map((listing) => (
            <ListingCard key={listing.id} listing={listing} />
          ))}
        </div>
      )}

      {listings && !listings.length && (
        <p className="py-14 text-center text-sm text-muted-foreground">
          {q ? `Nothing published matches “${q}”.` : 'Nothing published yet. Yours could be the first.'}
        </p>
      )}

      {cursor !== null && (
        <Button variant="outline" className="mx-auto mt-8 block" disabled={busy} onClick={() => void more()}>
          {busy ? 'Loading…' : 'Show more'}
        </Button>
      )}
    </div>
  )
}
