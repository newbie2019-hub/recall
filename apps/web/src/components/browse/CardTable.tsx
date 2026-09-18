import { ArrowDown, ArrowUp, Flag, PauseCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import type { BrowseCard, SortKey } from '@/db/queries/browse'
import { FLAG_COLORS, FLAG_NAMES } from './FilterBar'

const COLUMNS: { key: SortKey; label: string; className?: string }[] = [
  { key: 'card', label: 'Card', className: 'w-28' },
  { key: 'deck', label: 'Deck', className: 'w-36' },
  { key: 'due', label: 'Due', className: 'w-24 text-right' },
  { key: 'state', label: 'State', className: 'w-24' },
  { key: 'lapses', label: 'Lapses', className: 'w-16 text-right' },
  { key: 'reps', label: 'Reps', className: 'w-16 text-right' },
]

// Relative days rather than a date: "in 3 days" is the thing being judged, and
// Intl already knows how to say it in the user's language.
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
const DAY = 86_400_000

function dueLabel(c: BrowseCard, now: number): string {
  if (c.state === 'new') return '—'
  return rtf.format(Math.round((c.due - now) / DAY), 'day')
}

export function CardTable({
  rows, selected, sort, onSort, onToggle, onTogglePage, onOpen,
}: {
  rows: BrowseCard[] | null
  selected: ReadonlySet<string>
  sort: { by: SortKey; dir: 'asc' | 'desc' }
  onSort: (by: SortKey) => void
  onToggle: (id: string, on: boolean) => void
  onTogglePage: (on: boolean) => void
  onOpen: (noteId: string) => void
}) {
  if (!rows) {
    return (
      <div className="space-y-2 py-2">
        {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-8 w-full" />)}
      </div>
    )
  }
  if (!rows.length) {
    return <p className="py-16 text-center text-sm text-muted-foreground">Nothing matches that.</p>
  }

  const now = Date.now()
  const pageSelected = rows.every((r) => selected.has(r.id))

  return (
    <table className="w-full table-fixed border-collapse text-sm">
      <thead>
        <tr className="border-b border-border">
          <th className="w-8 py-2">
            <input
              type="checkbox"
              // Native, not a component: a tick box is one of the few controls
              // the platform already gets right, including the keyboard.
              className="size-3.5 accent-[var(--hematoxylin)] align-middle"
              checked={pageSelected}
              onChange={(e) => onTogglePage(e.target.checked)}
              aria-label={pageSelected ? 'Deselect this page' : 'Select this page'}
            />
          </th>
          <th className="py-2 text-left"><Head label="Question" /></th>
          {COLUMNS.map((c) => (
            <th key={c.key} className={`py-2 ${c.className ?? ''}`}
                aria-sort={sort.by !== c.key ? undefined : sort.dir === 'asc' ? 'ascending' : 'descending'}>
              <Head label={c.label} sorted={sort.by === c.key ? sort.dir : null}
                    onClick={() => onSort(c.key)} />
            </th>
          ))}
          <th className="w-40 py-2 text-left"><Head label="Tags" /></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={r.id}
            data-selected={selected.has(r.id) || undefined}
            className="border-b border-border/60 last:border-0 data-selected:bg-accent/40 hover:bg-accent/20"
          >
            <td className="py-1.5 text-center">
              <input
                type="checkbox"
                className="size-3.5 accent-[var(--hematoxylin)] align-middle"
                checked={selected.has(r.id)}
                onChange={(e) => onToggle(r.id, e.target.checked)}
                aria-label={`Select ${r.preview || 'card'}`}
              />
            </td>
            <td className="py-1.5">
              <button
                onClick={() => onOpen(r.note_id)}
                className="flex w-full items-center gap-1.5 text-left hover:text-hematoxylin"
              >
                {r.flag > 0 && (
                  <Flag
                    className="size-3 shrink-0"
                    style={{ color: FLAG_COLORS[r.flag - 1], fill: FLAG_COLORS[r.flag - 1] }}
                    aria-label={`Flag: ${FLAG_NAMES[r.flag - 1]}`}
                  />
                )}
                {r.suspended && (
                  <PauseCircle className="size-3 shrink-0 text-muted-foreground" aria-label="Suspended" />
                )}
                <span className={`truncate font-body ${r.suspended ? 'text-muted-foreground line-through' : ''}`}>
                  {r.preview || '(empty)'}
                </span>
              </button>
            </td>
            <td className="truncate py-1.5 font-mono text-[0.6875rem] text-muted-foreground">{r.template}</td>
            <td className="truncate py-1.5 text-xs text-muted-foreground">{r.deck_name}</td>
            <td className="py-1.5 text-right font-mono text-[0.6875rem] text-muted-foreground">
              {dueLabel(r, now)}
            </td>
            <td className="py-1.5">
              <Badge variant="outline" className="font-mono text-[0.625rem] text-muted-foreground">
                {r.state}
              </Badge>
            </td>
            <td className={`py-1.5 text-right font-mono text-[0.6875rem] ${r.lapses >= 3 ? 'text-eosin' : 'text-muted-foreground'}`}>
              {r.lapses}
            </td>
            <td className="py-1.5 text-right font-mono text-[0.6875rem] text-muted-foreground">{r.reps}</td>
            <td className="truncate py-1.5 font-mono text-[0.625rem] text-muted-foreground">
              {r.tags.join(' ')}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Head({
  label, sorted, onClick,
}: {
  label: string
  sorted?: 'asc' | 'desc' | null
  onClick?: () => void
}) {
  const text = <span className="text-[0.625rem] tracking-[0.14em] uppercase">{label}</span>
  if (!onClick) return <span className="px-1 text-muted-foreground">{text}</span>
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1 px-1 hover:text-foreground
        ${sorted ? 'text-foreground' : 'text-muted-foreground'}`}
    >
      {text}
      {sorted === 'asc' && <ArrowUp className="size-2.5" />}
      {sorted === 'desc' && <ArrowDown className="size-2.5" />}
    </button>
  )
}
