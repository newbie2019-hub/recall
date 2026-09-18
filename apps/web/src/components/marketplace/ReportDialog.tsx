import { useState } from 'react'
import { Link } from 'react-router'
import { Flag } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { useAuth } from '@/lib/auth'
import { REPORT_REASONS, reportListing, type ReportReason } from '@/lib/marketplace'
import { paths } from '@/routes/paths'

/**
 * Reporting a listing. On every public deck, not buried in a menu (PHASES §8).
 *
 * Sign-in is required, and the dialog says so before the person writes anything
 * — an anonymous report is unrate-limitable and, for a copyright notice, worth
 * nothing without someone to correspond with.
 *
 * A copyright report is *not* a takedown notice. Both intake paths have to
 * exist (Copyright Act 1968 here, DMCA-shaped notices from the US), and a
 * dropdown cannot collect a sworn statement — so this records the report and
 * points at the formal route.
 */
export function ReportDialog({ listingId }: { listingId: string }) {
  const { user } = useAuth()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<ReportReason>('copyright')
  const [detail, setDetail] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    try {
      await reportListing(listingId, { reason, detail })
      setOpen(false)
      setDetail('')
      toast('Reported. A moderator sees this with the deck attached.')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-muted-foreground">
          <Flag /> Report
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Report this deck</DialogTitle>
          <DialogDescription>
            {user
              ? 'A moderator reads every report. Say what is wrong with it — a reason on its own is hard to act on.'
              : 'Reports are tied to an account so a moderator can follow them up.'}
          </DialogDescription>
        </DialogHeader>

        {!user ? (
          <Button asChild>
            <Link to={paths.signIn}>Sign in to report</Link>
          </Button>
        ) : (
          <>
            <div className="grid gap-2">
              <Label htmlFor="report-reason">Reason</Label>
              <Select value={reason} onValueChange={(v) => setReason(v as ReportReason)}>
                <SelectTrigger id="report-reason">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(REPORT_REASONS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="report-detail">What is wrong with it</Label>
              <textarea
                id="report-detail"
                rows={4}
                value={detail}
                onChange={(e) => setDetail(e.target.value)}
                className="border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              />
            </div>

            {reason === 'copyright' && (
              <p className="text-xs text-muted-foreground">
                This records a report. A formal takedown notice — Copyright Act 1968
                or DMCA — goes to the contact address on the marketplace page, and
                gets a counter-notice reply path.
              </p>
            )}

            <DialogFooter>
              <Button disabled={busy || !detail.trim()} onClick={() => void submit()}>
                {busy ? 'Sending…' : 'Send report'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
