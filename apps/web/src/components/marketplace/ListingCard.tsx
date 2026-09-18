import { Link } from 'react-router'
import { Badge } from '@/components/ui/badge'
import { ago, formatBytes, type Listing } from '@/lib/marketplace'
import { paths } from '@/routes/paths'

/**
 * One deck in the grid, as a specimen tag (UI.md §2).
 *
 * `install_count` is the only number here that could be mistaken for social
 * proof, and it is real: it counts decks that were actually cloned, once each.
 * There are no ratings in this phase and no stars are drawn — a "★ 4.8" with
 * nothing behind it is worse than no number at all.
 *
 * Size and card count come from the latest version, which browse does not load.
 * The tile shows them when it has them rather than guessing — see the report;
 * the fix is server-side and small.
 */
export function ListingCard({ listing }: { listing: Listing }) {
  const latest = listing.versions?.find((v) => v.version === listing.latest_version)

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
        {latest && (
          <>
            <div className="flex gap-1">
              <dt className="sr-only">notes</dt>
              <dd className="text-foreground">{latest.note_count.toLocaleString()}</dd>
              <span>notes</span>
            </div>
            <div className="flex gap-1">
              <dt className="sr-only">download size</dt>
              <dd>{formatBytes(latest.size_bytes)}</dd>
            </div>
          </>
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

      <p className="font-sans text-[0.625rem] tracking-[0.18em] text-muted-foreground uppercase">
        {listing.publisher?.name ?? 'Unknown'} · {ago(listing.published_at)}
      </p>
    </Link>
  )
}
