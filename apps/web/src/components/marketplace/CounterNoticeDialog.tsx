import { useState } from 'react'
import { Link } from 'react-router'
import { Undo2 } from 'lucide-react'
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
import { REPORT_REASONS, reportListing, type Listing, type ReportReason } from '@/lib/marketplace'
import { paths } from '@/routes/paths'

/**
 * The publisher's answer to a takedown.
 *
 * It files the same shape as a report — one queue, one conversation about one
 * listing — with `kind: 'counter_notice'`, which the server accepts only from
 * the publisher of the deck in question.
 *
 * The wording is deliberately plain about what this is and is not: it is a
 * reply that a human will read, not a form that reinstates anything by itself,
 * and it is not the formal statutory notice. Promising more than that in a
 * dialog is how a person ends up believing they have done something they
 * have not.
 */
export function CounterNoticeDialog({
  listing,
  onFiled,
}: {
  listing: Listing
  onFiled: () => void
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<ReportReason>('copyright')
  const [detail, setDetail] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    try {
      await reportListing(listing.id, { reason, detail, kind: 'counter_notice' })
      setOpen(false)
      setDetail('')
      toast('Filed. It reaches the same queue as the report, with the removal attached.')
      onFiled()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Undo2 /> File a counter-notice
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Answer this removal</DialogTitle>
          <DialogDescription>
            A moderator reads this beside the report that removed the deck. Say
            why the removal is wrong — where the material came from, and what
            gives you the right to publish it.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          <Label htmlFor="counter-reason">What the removal was about</Label>
          <Select value={reason} onValueChange={(v) => setReason(v as ReportReason)}>
            <SelectTrigger id="counter-reason">
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
          <Label htmlFor="counter-detail">Your answer</Label>
          <textarea
            id="counter-detail"
            rows={5}
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            className="border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
        </div>

        <p className="text-xs text-muted-foreground">
          This is a reply a person will read, not a statutory counter-notice and
          not an automatic reinstatement. The formal route, and the address for
          it, are on{' '}
          <Link to={paths.legal} className="underline hover:text-hematoxylin">
            Rights &amp; takedowns
          </Link>
          .
        </p>

        <DialogFooter>
          <Button disabled={busy || !detail.trim()} onClick={() => void submit()}>
            {busy ? 'Filing…' : 'File counter-notice'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
