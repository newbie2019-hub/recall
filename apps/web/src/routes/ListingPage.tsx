import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { ApiError } from '@recall/core'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { CardPreview } from '@/components/marketplace/CardPreview'
import { CloneButton } from '@/components/marketplace/CloneButton'
import { ReportDialog } from '@/components/marketplace/ReportDialog'
import { RatePicker, Stars } from '@/components/marketplace/Stars'
import { useAuth } from '@/lib/auth'
import { ago, formatBytes, getListing, RIGHTS, type ListingPage as ListingData } from '@/lib/marketplace'
import { NotFoundPage } from './NotFoundPage'
import { paths } from './paths'

/**
 * One published deck, signed in or not.
 *
 * Everything on this page was written by a stranger. Text is rendered as React
 * children, so it is escaped; card HTML and card CSS go only into `CardFrame`,
 * which runs no scripts (README rule 5). There is no `dangerouslySetInnerHTML`
 * on this page and there must never be one.
 */
export function ListingPage() {
  const { listingId } = useParams()
  const { user } = useAuth()
  const [data, setData] = useState<ListingData | null>(null)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    if (!listingId) return
    let cancelled = false
    setData(null)
    setError(null)
    void getListing(listingId)
      .then((d) => !cancelled && setData(d))
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)))
      })
    return () => {
      cancelled = true
    }
  }, [listingId])

  // A deck that was taken down, or a link that was never right, is a dead link
  // — not a broken screen. The server answers 404 rather than 403 on purpose:
  // whether a removed deck ever existed is not a stranger's business.
  if (error instanceof ApiError && (error.code === 'not_found' || error.code === 'forbidden')) {
    return <NotFoundPage />
  }

  if (error) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-3 px-6">
        <h1 className="font-display text-3xl">Can't load this deck</h1>
        <p className="text-sm text-muted-foreground">
          Published decks live on the server. Your own collection is unaffected.
        </p>
        <p className="font-mono text-xs text-eosin">{error.message}</p>
        <Button variant="outline" className="mt-2 self-start" asChild>
          <Link to={paths.marketplace}>Back to Explore</Link>
        </Button>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="mx-auto min-h-dvh max-w-3xl space-y-4 px-4 py-10 sm:px-6">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-72 w-full" />
      </div>
    )
  }

  const { listing, preview, yourRating } = data
  const versions = listing.versions ?? []
  const latest = versions.find((v) => v.version === listing.latest_version)

  return (
    <div className="mx-auto min-h-dvh max-w-3xl px-4 py-10 sm:px-6">
      <Button variant="ghost" size="sm" className="-ml-2 mb-6" asChild>
        <Link to={paths.marketplace}>← Explore</Link>
      </Button>

      <header className="mb-6">
        <h1 className="font-display text-4xl tracking-tight">{listing.title}</h1>
        <p className="mt-2 font-sans text-[0.6875rem] tracking-[0.18em] text-muted-foreground uppercase">
          {listing.publisher?.name ?? 'Unknown'} · v{listing.latest_version}
          {latest?.semver && ` (${latest.semver})`} · published {ago(listing.published_at)}
          {listing.visibility === 'unlisted' && ' · unlisted'}
        </p>
      </header>

      <dl className="mb-6 flex flex-wrap gap-x-8 gap-y-2 font-mono text-xs">
        {latest && <Stat label="notes" value={latest.note_count.toLocaleString()} />}
        {latest && <Stat label="download" value={formatBytes(latest.size_bytes)} />}
        <Stat label="cloned" value={listing.install_count.toLocaleString()} />
        <div className="flex items-baseline gap-2">
          <dt className="text-muted-foreground">rated</dt>
          <dd>
            <Stars average={listing.rating_average} count={listing.rating_count} />
          </dd>
        </div>
      </dl>

      <div className="mb-8">
        <CloneButton listing={listing} />
      </div>

      {/* Only where a rating can actually be left. The server refuses one from
          anybody who has not cloned the deck, and a control that exists to
          refuse is worse than no control. */}
      {user && (
        <div className="mb-8">
          <RatePicker
            listing={listing}
            yours={yourRating}
            onRated={({ average, count, yours }) =>
              setData((d) =>
                d && {
                  ...d,
                  listing: { ...d.listing, rating_average: average, rating_count: count },
                  yourRating: yours,
                },
              )
            }
          />
        </div>
      )}

      {listing.tags.length > 0 && (
        <div className="mb-8 flex flex-wrap gap-1">
          {listing.tags.map((tag) => (
            <Badge key={tag} variant="outline" className="font-mono text-[0.625rem]">
              {tag}
            </Badge>
          ))}
        </div>
      )}

      <section className="mb-10">
        <h2 className="mb-3 text-sm tracking-wide uppercase">Sample cards</h2>
        <CardPreview listing={listing} preview={preview} />
      </section>

      {listing.description && (
        <section className="mb-10">
          <h2 className="mb-3 text-sm tracking-wide uppercase">About this deck</h2>
          <p className="font-body text-sm whitespace-pre-wrap">{listing.description}</p>
        </section>
      )}

      {versions.length > 0 && (
        <section className="mb-10">
          <h2 className="mb-3 text-sm tracking-wide uppercase">Versions</h2>
          <ul className="space-y-2">
            {versions.map((v) => (
              <li key={v.version} className="flex gap-4 text-sm">
                <span className="w-16 shrink-0 font-mono text-xs text-muted-foreground">
                  v{v.version}
                </span>
                <span className="flex-1 whitespace-pre-wrap">
                  {v.changelog || <span className="text-muted-foreground">No notes</span>}
                </span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {ago(v.published_at)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Separator className="mb-4" />

      <footer className="flex flex-wrap items-center justify-between gap-2">
        {/* The rights claim is recorded with the version and shown here, because
            a claim nobody can see is a claim nobody can check (PHASES §8). */}
        <p className="max-w-md text-xs text-muted-foreground">
          {latest ? RIGHTS[latest.rights_attestation] ?? 'Rights not stated' : 'Rights not stated'}
          {' · '}
          <Link to={paths.legal} className="underline hover:text-hematoxylin">
            Rights &amp; takedowns
          </Link>
        </p>
        <ReportDialog listingId={listing.id} />
      </footer>
    </div>
  )
}

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-baseline gap-2">
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="text-sm">{value}</dd>
  </div>
)
