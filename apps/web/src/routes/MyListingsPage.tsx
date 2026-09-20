import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { CounterNoticeDialog } from '@/components/marketplace/CounterNoticeDialog'
import { Stars } from '@/components/marketplace/Stars'
import { useAuth } from '@/lib/auth'
import { ago, myListings, unpublishListing, type Listing, type ListingStatus } from '@/lib/marketplace'
import { paths } from './paths'

/**
 * The publisher's shelf: everything they have published, in every state.
 *
 * This screen exists because of one state. A deck that has been taken down is
 * invisible everywhere else — it is gone from Explore, its listing page answers
 * 404 to strangers, and the publisher would otherwise find out only by noticing
 * that a link stopped working. PHASES §8 asks for a counter-notice flow, and a
 * counter-notice flow that starts with "discover you have been removed" is not
 * one. So the removal is stated here, with the reason, and the reply is the
 * button next to it.
 *
 * `in_review` is the other state worth a screen: a first-time publisher's deck
 * does not distribute until a human has looked at it, and silence would read as
 * a bug.
 */
export function MyListingsPage() {
  const { user, loading } = useAuth()
  const [listings, setListings] = useState<Listing[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    if (!user) return
    myListings()
      .then(setListings)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [user])

  useEffect(() => void load(), [load])

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  if (!user) {
    return (
      <div className="mx-auto flex max-w-md flex-col justify-center gap-3 py-20">
        <h1 className="font-display text-3xl">Published decks live on your account</h1>
        <p className="text-sm text-muted-foreground">
          Sign in to see what you have published. Your collection on this device
          is unaffected either way.
        </p>
        <div className="mt-2 flex gap-2">
          <Button variant="outline" asChild>
            <Link to={paths.signIn}>Sign in</Link>
          </Button>
          <Button variant="ghost" asChild>
            <Link to={paths.decks}>All decks</Link>
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl">
      <Button variant="ghost" size="sm" className="-ml-2 mb-6" asChild>
        <Link to={paths.decks}>← All decks</Link>
      </Button>

      <h1 className="font-display text-4xl tracking-tight">Your published decks</h1>
      <p className="mt-2 mb-8 text-sm text-muted-foreground">
        Publishing freezes a version. Editing the deck here changes nothing for
        anyone who cloned it until you publish again.
      </p>

      {error && <p className="mb-6 font-mono text-xs text-eosin">{error}</p>}
      {!listings && !error && <Skeleton className="h-40 w-full" />}

      {listings?.length === 0 && (
        <p className="py-14 text-center text-sm text-muted-foreground">
          Nothing published yet. Any deck can be published from its menu on the
          deck list.
        </p>
      )}

      <ul className="space-y-6">
        {listings?.map((listing) => (
          <li key={listing.id} className="specimen-tag p-5 pt-6">
            <div className="flex flex-wrap items-start justify-between gap-3 pl-6">
              <div className="min-w-0">
                <Link
                  to={paths.listing(listing.id)}
                  className="text-base hover:text-hematoxylin"
                >
                  {listing.title}
                </Link>
                <p className="mt-1 font-mono text-[0.6875rem] text-muted-foreground">
                  v{listing.latest_version} · {listing.install_count.toLocaleString()} cloned ·{' '}
                  {listing.published_at ? `published ${ago(listing.published_at)}` : 'not live'}
                </p>
              </div>
              <StatusBadge status={listing.status} visibility={listing.visibility} />
            </div>

            <div className="mt-3 pl-6">
              <Stars average={listing.rating_average} count={listing.rating_count} />
            </div>

            {listing.status === 'in_review' && (
              <p className="mt-3 pl-6 text-xs text-muted-foreground">
                Waiting for a moderator to look at it. A first deck from a new
                account does not distribute until somebody has — after that,
                publishing is immediate.
              </p>
            )}

            {listing.status === 'removed' && (
              <div className="mt-3 space-y-3 pl-6">
                <p className="text-xs text-eosin">
                  Removed{listing.moderated_at ? ` ${ago(listing.moderated_at)}` : ''}. Nobody
                  can download it. Decks people already cloned are their own and
                  are untouched.
                </p>
                {listing.moderation_reason && (
                  <p className="border-l-2 border-border pl-3 font-body text-sm whitespace-pre-wrap">
                    {listing.moderation_reason}
                  </p>
                )}
                <CounterNoticeDialog listing={listing} onFiled={load} />
              </div>
            )}

            <div className="mt-4 flex flex-wrap gap-2 pl-6">
              {listing.deck_id && (
                <Button variant="outline" size="sm" asChild>
                  <Link to={paths.publishDeck(listing.deck_id)}>
                    Publish v{listing.latest_version + 1}
                  </Link>
                </Button>
              )}
              {listing.status === 'published' && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void unpublishListing(listing.id)
                      .then(() => {
                        toast('Stopped distributing. Your versions stay on file.')
                        load()
                      })
                      .catch((e: unknown) =>
                        toast(e instanceof Error ? e.message : String(e)),
                      )
                  }}
                >
                  Stop distributing
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The state, in the publisher's words rather than the column's.
 *
 * `unlisted` is shown beside `published` rather than instead of it: a deck can
 * be live and unfindable at once, and collapsing the two would hide the only
 * difference a moderator's unlist makes.
 */
function StatusBadge({
  status,
  visibility,
}: {
  status?: ListingStatus
  visibility?: string
}) {
  const label: Record<ListingStatus, string> = {
    draft: 'Not distributing',
    in_review: 'In review',
    published: 'Live',
    removed: 'Removed',
  }

  return (
    <div className="flex shrink-0 gap-1">
      <Badge
        variant="outline"
        className={`font-mono text-[0.625rem] ${status === 'removed' ? 'text-eosin' : ''}`}
      >
        {status ? label[status] : 'Unknown'}
      </Badge>
      {status === 'published' && visibility === 'unlisted' && (
        <Badge variant="outline" className="font-mono text-[0.625rem]">
          link only
        </Badge>
      )}
    </div>
  )
}
