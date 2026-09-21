import { useEffect, useState } from 'react'
import { formatInterval } from '@recall/core'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { cardInfo, type CardInfo } from '@/db/queries/cardInfo'
import { cn } from '@/lib/utils'

/**
 * Everything this card has been through.
 *
 * The column worth the screen is **Expected**: what the scheduler thought your
 * chance of recall was, immediately before you answered. Anki cannot show it —
 * it does not keep historical retrievability — and it is what separates "you
 * keep failing this" from "you keep failing this at intervals the model was
 * sure about", which are different problems with different fixes.
 *
 * Nothing here is actionable on purpose. It is the screen you open to find out
 * why, and every button that acts on a card already lives on the row or the
 * reviewer behind it.
 */
export function CardInfoDialog({ cardId, onClose }: { cardId: string | null; onClose: () => void }) {
  const [info, setInfo] = useState<CardInfo | null>(null)

  useEffect(() => {
    if (!cardId) return
    setInfo(null)
    let live = true
    void cardInfo(cardId).then((next) => { if (live) setInfo(next) })
    return () => { live = false }
  }, [cardId])

  return (
    <Dialog open={!!cardId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Card info</DialogTitle>
          <DialogDescription>
            {info
              ? `${info.card.note_type} · ${info.card.template} · ${info.card.deck_name}`
              : 'Reading the log…'}
          </DialogDescription>
        </DialogHeader>

        {info && (
          <>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
              <Fact label="Added" value={date(info.card.created_at)} />
              <Fact label="State" value={info.card.state} />
              <Fact
                label="Due"
                value={info.card.state === 'new' ? 'in the new queue' : date(info.card.due)}
                note={info.card.due_override != null ? 'a date you set' : undefined}
              />
              <Fact
                label="Interval"
                value={info.card.interval_days > 0
                  ? formatInterval(0, info.card.interval_days * 86_400_000)
                  : '—'}
              />
              <Fact
                label="Stability"
                value={info.card.stability > 0 ? `${info.card.stability.toFixed(1)}d` : '—'}
                note="days until recall falls to 90%"
              />
              <Fact label="Difficulty" value={info.card.difficulty > 0 ? info.card.difficulty.toFixed(1) : '—'} />
              <Fact
                label="Recall now"
                value={info.card.last_review ? pct(info.card.retrievability) : '—'}
              />
              <Fact label="Reviews" value={String(info.card.reps)} />
              <Fact label="Lapses" value={String(info.card.lapses)} />
              <Fact label="Total time" value={secs(info.total_ms)} />
              <Fact label="Median answer" value={secs(info.median_ms)} />
              {info.card.forgotten_at != null && (
                <Fact label="Forgotten" value={date(info.card.forgotten_at)} note="scheduling restarts here" />
              )}
            </dl>

            {info.reviews.length === 0 ? (
              <p className="border-t border-border pt-4 text-sm text-muted-foreground">
                Never answered. Everything above is the starting position, not a measurement.
              </p>
            ) : (
              <div className="border-t border-border pt-4">
                <table className="w-full text-left font-mono text-xs tabular-nums">
                  <thead className="text-muted-foreground">
                    <tr className="border-b border-border">
                      <Th>When</Th>
                      <Th>Answer</Th>
                      <Th right>Gap</Th>
                      <Th right>Expected</Th>
                      <Th right>Time</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* Newest first: the reason you opened this is usually the
                        last thing that happened. */}
                    {[...info.reviews].reverse().map((r) => (
                      <tr key={r.ts} className="border-b border-border/50 last:border-0">
                        <td className="py-1.5">{date(r.ts)}</td>
                        <td className={cn('py-1.5', !r.recalled && 'text-eosin')}>
                          {RATINGS[r.rating] ?? r.rating}
                          {r.imported && <span className="ml-1 text-muted-foreground">(imported)</span>}
                        </td>
                        <td className="py-1.5 text-right">
                          {r.elapsedDays > 0 ? formatInterval(0, r.elapsedDays * 86_400_000) : '—'}
                        </td>
                        {/* Blank for a first sight rather than 0%: the model had
                            made no prediction, and printing one would read as a
                            confident wrong guess. */}
                        <td className="py-1.5 text-right">{r.predicted > 0 ? pct(r.predicted) : '—'}</td>
                        <td className="py-1.5 text-right text-muted-foreground">
                          {r.duration_ms > 0 ? secs(r.duration_ms) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

const RATINGS: Record<number, string> = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' }

const Th = ({ children, right }: { children: React.ReactNode; right?: boolean }) => (
  <th className={cn('pb-1.5 font-normal', right && 'text-right')}>{children}</th>
)

const Fact = ({ label, value, note }: { label: string; value: string; note?: string }) => (
  <div>
    <dt className="text-xs text-muted-foreground">{label}</dt>
    <dd className="font-mono text-sm tabular-nums">{value}</dd>
    {note && <dd className="text-[0.6875rem] text-muted-foreground">{note}</dd>}
  </div>
)

const date = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

const pct = (r: number) => `${Math.round(r * 100)}%`

const secs = (ms: number) => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : `${(ms / 1000).toFixed(1)}s`)
