import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, MoreHorizontal, Plus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import * as repo from '@/db/repo'

/**
 * Desired retention, as a short list rather than the slider UI.md drew.
 *
 * A slider promises precision this number does not have — nobody can tell 0.87
 * from 0.88, and FSRS gets expensive below about 0.95. Four labelled choices
 * say what each one costs, which is the thing a person actually decides.
 */
const RETENTIONS = [
  { value: '0.85', label: '85% — fewer reviews' },
  { value: '0.9', label: '90% — balanced' },
  { value: '0.93', label: '93% — fewer lapses' },
  { value: '0.95', label: '95% — exam week' },
]
const LABEL = 'text-[0.625rem] tracking-[0.14em] text-muted-foreground uppercase'

/** The card list for one deck and everything under it. */
export function Browse({
  deck, onBack, onOpen, onNew, onStudy, onEditDeck, onDeleteDeck, onNewSubdeck, onShare,
}: {
  deck: repo.DeckRow
  onBack: () => void
  onOpen: (noteId: string) => void
  onNew: () => void
  onStudy: () => void
  onEditDeck: () => void
  onDeleteDeck: () => void
  onNewSubdeck: () => void
  onShare?: () => void
}) {
  const [notes, setNotes] = useState<repo.NoteRow[] | null>(null)
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState({
    retention: String(deck.retention_target),
    newPerDay: String(deck.new_per_day),
    bury: deck.bury_new !== 0,
  })

  /**
   * Writes on change rather than on blur. Blur-to-save loses the edit whenever
   * the field is not the thing that lost focus, and an empty box mid-edit is
   * not a request to set the limit to zero — so a blank simply does not write.
   */
  const saveOptions = (patch: Partial<typeof options>) => {
    const next = { ...options, ...patch }
    setOptions(next)
    const perDay = Number(next.newPerDay)
    if (next.newPerDay.trim() && Number.isFinite(perDay))
      void repo.setDeckOptions(deck.id, Number(next.retention), perDay, next.bury)
  }

  const load = useCallback(async () => setNotes(await repo.notesInDeck(deck.id)), [deck.id])
  useEffect(() => void load(), [load])

  const needle = query.trim().toLowerCase()
  const shown = (notes ?? []).filter(
    (n) => !needle || n.preview.toLowerCase().includes(needle) || n.tags.some((t) => t.toLowerCase().includes(needle)),
  )

  return (
    <div className="mx-auto min-h-dvh max-w-3xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <Button variant="ghost" size="sm" className="-ml-2 mb-3 text-muted-foreground" onClick={onBack}>
          <ChevronLeft /> All decks
        </Button>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="font-display text-4xl tracking-tight">{deck.name}</h1>
          <div className="flex items-center gap-2">
            <p className="font-sans text-[0.625rem] tracking-[0.18em] text-muted-foreground uppercase">
              {deck.path}
            </p>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Deck options">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={onNewSubdeck}>New subdeck</DropdownMenuItem>
                <DropdownMenuItem onClick={onEditDeck}>Rename or move</DropdownMenuItem>
                {onShare && <DropdownMenuItem onClick={onShare}>Share…</DropdownMenuItem>}
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={onDeleteDeck}>
                  Delete deck
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <div className="mb-6 flex gap-2">
        <Input value={query} onChange={(e) => setQuery(e.target.value)}
               placeholder="Search this deck" className="flex-1" aria-label="Search this deck" />
        <Button onClick={onNew}><Plus /> New note</Button>
        <Button variant="outline" disabled={!deck.due && !deck.new} onClick={onStudy}>
          Study
        </Button>
      </div>

      <div className="mb-6 flex flex-wrap items-end gap-4 border-y border-border py-3">
        <div className="space-y-1.5">
          <Label htmlFor="retention" className={LABEL}>Desired retention</Label>
          <Select value={options.retention}
                  onValueChange={(v) => saveOptions({ retention: v })}>
            <SelectTrigger id="retention" size="sm" className="w-52 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {RETENTIONS.map((r) => (
                <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="new-per-day" className={LABEL}>New cards a day</Label>
          <Input id="new-per-day" type="number" min={0} max={9999}
                 className="h-8 w-24 font-mono text-xs"
                 value={options.newPerDay}
                 onChange={(e) => saveOptions({ newPerDay: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bury" className={LABEL}>Bury siblings</Label>
          <div className="flex h-8 items-center gap-2">
            <Switch
              id="bury"
              checked={options.bury}
              onCheckedChange={(v) => saveOptions({ bury: v })}
            />
            <span className="text-xs text-muted-foreground">until tomorrow</span>
          </div>
        </div>
        <p className="max-w-xs text-xs text-muted-foreground">
          Applies to {deck.name} itself. Changing retention affects the next review of
          each card, never one already logged. Burying hides a note's other cards once
          you answer one, so you do not grade a reverse you were just shown.
        </p>
      </div>

      <ul>
        {shown.map((n) => (
          <li key={n.id} className="border-b border-border last:border-0">
            <button
              onClick={() => onOpen(n.id)}
              className="flex w-full items-center gap-3 py-3 text-left hover:text-hematoxylin"
            >
              <span className="line-clamp-2 flex-1 font-body text-sm">{n.preview || '(empty)'}</span>
              {n.tags.slice(0, 2).map((t) => (
                <Badge key={t} variant="outline" className="font-mono text-[0.625rem] text-muted-foreground">
                  {t}
                </Badge>
              ))}
              <span className="w-14 shrink-0 text-right font-mono text-[0.625rem] text-muted-foreground">
                {n.cards} {n.cards === 1 ? 'card' : 'cards'}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {notes && !shown.length && (
        <p className="py-14 text-center text-sm text-muted-foreground">
          {needle ? 'Nothing matches that.' : 'No notes here yet.'}
        </p>
      )}
    </div>
  )
}
