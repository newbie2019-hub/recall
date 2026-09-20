import { useState } from 'react'
import { Star } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError } from '@recall/core'
import { rateListing, type Listing } from '@/lib/marketplace'

/**
 * Stars, printed and collected.
 *
 * Two rules, both deliberate. **An unrated deck shows nothing** — not an empty
 * five-star row, which reads as zero, and not "★ 0.0", which is a claim nobody
 * made. And **the count is always printed beside the average**, because 5.0
 * from one person and 4.3 from ninety are different facts and a bare star hides
 * which one you are looking at.
 *
 * Only people who cloned the deck may rate it; the server enforces that and
 * says so in the 403, which is surfaced rather than swallowed — "add it to your
 * collection first" is an instruction, not an error.
 */
export function Stars({ average, count }: { average: number | null; count: number }) {
  if (average === null || count === 0) {
    return <span className="font-mono text-[0.6875rem] text-muted-foreground">not rated yet</span>
  }

  return (
    <span className="flex items-center gap-1 font-mono text-[0.6875rem] text-muted-foreground">
      <Star className="size-3 fill-current text-hematoxylin" aria-hidden />
      <span className="text-foreground">{average.toFixed(1)}</span>
      <span>
        from {count} {count === 1 ? 'person' : 'people'}
      </span>
    </span>
  )
}

/**
 * The five buttons. Rendered only where a rating can actually be left, so it
 * never appears to someone signed out — a control that exists to refuse is
 * worse than no control.
 */
export function RatePicker({
  listing,
  yours,
  onRated,
}: {
  listing: Listing
  yours: number
  onRated: (summary: { average: number | null; count: number; yours: number }) => void
}) {
  const [busy, setBusy] = useState(false)
  const [hover, setHover] = useState(0)

  async function rate(stars: number) {
    setBusy(true)
    try {
      const summary = await rateListing(listing.id, stars)
      onRated({
        average: summary.rating_count ? summary.rating_sum / summary.rating_count : null,
        count: summary.rating_count,
        yours: summary.your_rating,
      })
      toast(`Rated ${stars} of 5.`)
    } catch (e) {
      // The 403 here is the install rule, and its message is the instruction.
      toast(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const shown = hover || yours

  return (
    <div className="flex items-center gap-2">
      <div className="flex" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            disabled={busy}
            aria-label={`Rate ${n} of 5`}
            aria-pressed={yours === n}
            onMouseEnter={() => setHover(n)}
            onFocus={() => setHover(n)}
            onClick={() => void rate(n)}
            className="p-0.5 text-muted-foreground hover:text-hematoxylin disabled:opacity-50"
          >
            <Star className={`size-4 ${n <= shown ? 'fill-current text-hematoxylin' : ''}`} />
          </button>
        ))}
      </div>
      <span className="text-xs text-muted-foreground">
        {yours ? `You rated this ${yours}` : 'Rate this deck'}
      </span>
    </div>
  )
}
