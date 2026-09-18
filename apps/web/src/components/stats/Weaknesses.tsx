/**
 * The two lists that name what is wrong, rather than plotting what happened.
 *
 * Both are tables of text with one mark each, which is deliberate: the reader's
 * job here is to pick a card or a topic to go and fix, and a bar chart of
 * twenty tag names would be slower to read than twenty rows.
 */
import { useState } from 'react'
import { Bug, ChevronRight, EyeOff, Flag } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { LeechRow, TopicRow } from '@/db/queries/stats'

const pct = (n: number) => `${(n * 100).toFixed(0)}%`

/**
 * Worst topics by lapse rate, in tag-tree order.
 *
 * Indented by depth so `anatomy` sits above the `anatomy::thorax` it contains,
 * and the parent row is the rolled-up figure — the point being that a topic can
 * look fine leaf by leaf and still be the branch you keep failing.
 */
export function WorstTopics({ topics }: { topics: TopicRow[] }) {
  const [all, setAll] = useState(false)
  const shown = all ? topics : topics.slice(0, 8)
  if (!topics.length)
    return <Empty>Nothing has been failed often enough yet to call it a weak topic.</Empty>

  // The max, not the first row: the bar is drawn as a fraction of it, and a
  // caller that hands over an unsorted list would otherwise draw past the track.
  const worst = Math.max(...topics.map((t) => t.failed / t.tested))
  return (
    <div>
      <ul>
        {shown.map((t) => {
          const rate = t.failed / t.tested
          // `lastIndexOf` returns -1 on a root tag, and -1 + 2 would eat its
          // first letter — "anatomy" rendering as "natomy".
          const cut = t.tag.lastIndexOf('::')
          const leaf = cut < 0 ? t.tag : t.tag.slice(cut + 2)
          return (
            <li key={t.tag} className="flex items-center gap-3 border-b border-border py-2 last:border-0">
              <span className="min-w-0 flex-1" style={{ paddingLeft: `${t.depth * 0.875}rem` }}>
                <span className="block truncate text-sm">{leaf}</span>
                <span className="font-mono text-[0.6875rem] text-muted-foreground tabular-nums">
                  {t.failed} lapses · {t.tested} tests · {t.cards} cards
                </span>
              </span>
              {/* Bar to the tip, value beside it: the number never relies on
                  the colour, which is what lets the colour mean "worst". */}
              <span className="hidden h-2 w-24 shrink-0 bg-muted sm:block">
                <span
                  className={cn('block h-full', rate >= worst * 0.75 ? 'bg-eosin' : 'bg-primary')}
                  style={{ width: `${(rate / worst) * 100}%` }}
                />
              </span>
              <span className="w-10 shrink-0 text-right font-mono text-sm tabular-nums">
                {pct(rate)}
              </span>
            </li>
          )
        })}
      </ul>
      {topics.length > 8 && (
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => setAll(!all)}>
          <ChevronRight className={cn('transition-transform', all && 'rotate-90')} />
          {all ? 'Show fewer' : `All ${topics.length} topics`}
        </Button>
      )}
    </div>
  )
}

/**
 * Leeches, each with the reason — the part Anki does not do.
 *
 * "8 lapses" is a symptom with no action attached, so the tag gets ignored and
 * the card keeps costing reviews. Every row here says what the log actually
 * shows, and the remedy differs completely between the five reasons.
 */
export function Leeches({
  rows, onApply,
}: { rows: LeechRow[]; onApply: (row: LeechRow) => void }) {
  if (!rows.length) return <Empty>No leeches. Nothing has failed eight times over.</Empty>
  return (
    <ul>
      {rows.map((r) => (
        <li key={r.card_id} className="flex items-start gap-3 border-b border-border py-3 last:border-0">
          <Bug className="mt-0.5 size-4 shrink-0 text-eosin" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">{r.preview || <em>empty card</em>}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{r.verdict.reason?.text}</p>
            <p className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[0.6875rem] text-muted-foreground">
              <span className="tabular-nums">{r.deck}</span>
              <span>· card {r.ord + 1}</span>
              {r.suspended && (
                <Badge variant="outline" className="gap-1 font-mono text-[0.625rem]">
                  <EyeOff className="size-2.5" /> suspended
                </Badge>
              )}
              {!r.suspended && r.flag > 0 && (
                <Badge variant="outline" className="gap-1 font-mono text-[0.625rem]">
                  <Flag className="size-2.5" /> flagged
                </Badge>
              )}
            </p>
          </div>
          {!r.suspended && (
            <Button variant="outline" size="sm" className="shrink-0" onClick={() => onApply(r)}>
              {r.verdict.suspend ? 'Suspend' : 'Flag'}
            </Button>
          )}
        </li>
      ))}
    </ul>
  )
}

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="py-6 text-sm text-muted-foreground">{children}</p>
)
