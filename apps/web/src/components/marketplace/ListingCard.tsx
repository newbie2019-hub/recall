import { Link } from 'react-router'
import { Badge } from '@/components/ui/badge'
import { Stars } from '@/components/marketplace/Stars'
import { ago, formatBytes, type Listing } from '@/lib/marketplace'
import { paths } from '@/routes/paths'

/**
 * One deck in the grid, as a specimen tag (UI.md §2).
 *
 * Every number on it is real. `install_count` counts decks that were actually
 * cloned, once each, and the stars are an average over people who cloned the
 * deck — nobody else can leave one. An unrated deck says so rather than showing
 * an empty row of stars, which reads as zero.
 *
 * Size and card count come from the latest version, which browse loads as two
 * columns beside the listing rather than as the whole version — twenty tiles
 * would otherwise carry twenty decks.
 */
export function ListingCard({ listing }: { listing: Listing }) {
  // Browse sends these beside the listing; the detail page has `versions` and
  // reads the same two numbers from there.
  const latest = listing.versions?.find((v) => v.version === listing.latest_version)
  const noteCount = latest?.note_count ?? listing.note_count
  const sizeBytes = latest?.size_bytes ?? listing.size_bytes

  return (
    <Link
      to={paths.listing(listing.id)}
      className="specimen-tag flex flex-col gap-3 p-5 pt-6 transition-colors hover:border-hematoxylin"
    >
      <div className="flex items-start justify-between gap-3 pl-6">
        <h2 className="text-base leading-tight">{listing.title}</h2>
        <span className="shrink-0 font-mono text-[0.625rem] text-muted-foreground">
          v{listing.latest_version}
        </span>
      </div>

      {listing.description && (
        <p className="line-clamp-3 text-sm text-muted-foreground">{listing.description}</p>
      )}

      <dl className="mt-auto flex flex-wrap gap-x-4 gap-y-1 font-mono text-[0.6875rem] text-muted-foreground">
        {noteCount !== undefined && (
          <div className="flex gap-1">
            <dt className="sr-only">notes</dt>
            <dd className="text-foreground">{noteCount.toLocaleString()}</dd>
            <span>notes</span>
          </div>
        )}
        {sizeBytes !== undefined && (
          <div className="flex gap-1">
            <dt className="sr-only">download size</dt>
            <dd>{formatBytes(sizeBytes)}</dd>
          </div>
        )}
        {listing.install_count > 0 && (
          <div className="flex gap-1">
            <dt className="sr-only">collections holding it</dt>
            <dd>{listing.install_count.toLocaleString()} cloned</dd>
          </div>
        )}
      </dl>

      {listing.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {listing.tags.slice(0, 4).map((tag) => (
            <Badge key={tag} variant="outline" className="font-mono text-[0.625rem]">
              {tag}
            </Badge>
          ))}
        </div>
      )}

      <Stars average={listing.rating_average} count={listing.rating_count} />

      <p className="font-sans text-[0.625rem] tracking-[0.18em] text-muted-foreground uppercase">
        {listing.publisher?.name ?? 'Unknown'} · {ago(listing.published_at)}
      </p>
    </Link>
  )
}
