import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { ApiError } from '@recall/core'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ago, approveListing, dismissReport, openReports, REPORT_REASONS, takedownListing,
  unlistListing, type ModerationReport,
} from '@/lib/marketplace'
import { NotFoundPage } from './NotFoundPage'
import { paths } from './paths'

/**
 * The report queue, oldest first.
 *
 * Moderator-only, and there is no `is_moderator` flag on the client: the server
 * answers 403 and this renders the same "nothing here" any wrong URL gets. A
 * page that said "you are not a moderator" would be a page that tells every
 * visitor the queue exists.
 *
 * Four outcomes, each one click plus a reason — "a reported deck is down in
 * under a minute with a record of why" (PHASES §8) is a target this screen can
 * miss by making the moderator fill in a form. Take down, unlist and approve
 * act on the *listing*; dismiss closes the report and leaves the deck alone.
 * They are deliberately not one "resolve" call, because they are not one
 * decision — and unlist exists so that "miscategorised" and "infringing" do not
 * share a button.
 */
export function ModerationPage() {
  const [reports, setReports] = useState<ModerationReport[] | null>(null)
  const [error, setError] = useState<Error | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      setReports((await openReports()).items)
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)))
    }
  }, [])

  useEffect(() => void load(), [load])

  if (error instanceof ApiError && (error.code === 'forbidden' || error.code === 'not_found')) {
    return <NotFoundPage />
  }

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-6">
        <h1 className="font-display text-4xl tracking-tight">Reports</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every action here is recorded against the listing and the moderator. A
          takedown stops distribution and reaches nobody's collection.
        </p>
      </header>

      {error && <p className="font-mono text-xs text-eosin">{error.message}</p>}

      {!reports && !error && <Skeleton className="h-40 w-full" />}

      {reports && !reports.length && (
        <p className="py-14 text-center text-sm text-muted-foreground">Nothing waiting.</p>
      )}

      <ul className="space-y-4">
        {reports?.map((report) => (
          <ReportRow key={report.id} report={report} onDone={() => void load()} />
        ))}
      </ul>
    </div>
  )
}

function ReportRow({ report, onDone }: { report: ModerationReport; onDone: () => void }) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  async function act(what: 'dismiss' | 'takedown' | 'unlist' | 'approve') {
    setBusy(true)
    try {
      if (what === 'dismiss') await dismissReport(report.id, note.trim())
      if (what === 'takedown') await takedownListing(report.listing.id, note.trim())
      if (what === 'unlist') await unlistListing(report.listing.id, note.trim())
      if (what === 'approve') await approveListing(report.listing.id, note.trim())
      toast(`${report.listing.title}: ${what}`)
      onDone()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const counter = report.kind === 'counter_notice'

  return (
    <li className="specimen-tag p-5 pt-7">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <Link to={paths.listing(report.listing.id)} className="text-base hover:text-hematoxylin">
          {report.listing.title}
        </Link>
        <div className="flex items-center gap-2">
          {counter && (
            <Badge variant="outline" className="font-mono text-[0.625rem] text-hematoxylin">
              counter-notice
            </Badge>
          )}
          {(report.listing.open_report_count ?? 0) > 1 && (
            <Badge variant="outline" className="font-mono text-[0.625rem] text-eosin">
              {report.listing.open_report_count} open
            </Badge>
          )}
          <Badge variant="outline" className="font-mono text-[0.625rem]">
            {report.listing.status ?? report.listing.visibility}
          </Badge>
        </div>
      </div>

      <p className="mb-1 font-sans text-[0.625rem] tracking-[0.18em] text-muted-foreground uppercase">
        {REPORT_REASONS[report.reason] ?? report.reason} · {report.reporter?.name ?? 'deleted account'}{' '}
        · {ago(report.created_at)}
      </p>

      {/* A reporter's words, from an account nobody has vetted: rendered as text. */}
      <p className="mb-3 text-sm whitespace-pre-wrap">{report.detail}</p>

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Why — this is the record"
          aria-label={`Reason for acting on ${report.listing.title}`}
          className="flex-1 basis-48"
        />
        <Button size="sm" variant="outline" disabled={busy || !note.trim()} onClick={() => void act('dismiss')}>
          Dismiss
        </Button>
        <Button size="sm" variant="outline" disabled={busy || !note.trim()} onClick={() => void act('approve')}>
          {counter ? 'Reinstate' : 'Approve'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !note.trim()}
          title="Out of Explore, link still works. Existing clones keep updating."
          onClick={() => void act('unlist')}
        >
          Unlist
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={busy || !note.trim()}
          onClick={() => void act('takedown')}
        >
          Take down
        </Button>
      </div>
    </li>
  )
}
