import { useEffect, useState } from 'react'
import { Flag, FolderInput, PauseCircle, PlayCircle, Tag, Timer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  RESCHEDULABLE, bulkFlag, bulkMove, bulkReschedule, bulkRetag, bulkSuspend, targetCount,
  type Target, type Undo,
} from '@/db/queries/browse'
import type { DeckRow } from '@/db/repo'
import { FLAG_COLORS, FLAG_NAMES } from './FilterBar'

/**
 * A bulk operation big enough to want a second look before it happens.
 *
 * Undo exists for all of them, but undo is a promise you have to notice: a
 * toast that scrolls past while the person is already typing elsewhere is not
 * a recovery path. Below this, the toast is enough.
 */
const CONFIRM_AT = 50

type Pending =
  | { kind: 'reschedule' }
  | { kind: 'move' }
  | { kind: 'tag'; add: boolean }
  | { kind: 'confirm'; title: string; body: string; op: () => Promise<Undo> }

/**
 * The action bar, shown only when something is selected.
 *
 * Every action takes a `Target`, never a list of rows: when "all N matching" is
 * on, the operation re-runs the search at write time and changes exactly the N
 * the header promised, including the ones fifty pages down (README, rule 4).
 */
export function BulkBar({
  target, count, total, allMatching, decks, busy, onRun, onSelectAll, onClear,
}: {
  target: Target
  /** How many cards the current target holds — the number on every button. */
  count: number
  total: number
  allMatching: boolean
  decks: DeckRow[]
  busy: boolean
  onRun: (op: () => Promise<Undo>) => void
  onSelectAll: () => void
  onClear: () => void
}) {
  const [pending, setPending] = useState<Pending | null>(null)

  const go = (title: string, body: string, op: () => Promise<Undo>) =>
    count >= CONFIRM_AT ? setPending({ kind: 'confirm', title, body, op }) : onRun(op)

  const cards = `${count} ${count === 1 ? 'card' : 'cards'}`

  return (
    <div className="flex flex-wrap items-center gap-2 border-y border-border bg-accent/20 px-3 py-2">
      <span className="font-mono text-xs">{cards} selected</span>

      {/* The one honest way to act on more than a page: the search, not the
          ticks. Offered only when there is more behind the page than in it. */}
      {!allMatching && total > count && (
        <Button variant="link" size="xs" onClick={onSelectAll}>
          Select all {total} matching
        </Button>
      )}
      <Button variant="ghost" size="xs" onClick={onClear}>Clear</Button>

      <div className="ml-auto flex flex-wrap items-center gap-1">
        <Button variant="outline" size="xs" disabled={busy}
                onClick={() => go('Suspend cards', `Suspend ${cards}? They stop appearing in reviews until unsuspended.`,
                  () => bulkSuspend(target, true))}>
          <PauseCircle /> Suspend
        </Button>
        <Button variant="outline" size="xs" disabled={busy}
                onClick={() => go('Unsuspend cards', `Return ${cards} to review?`,
                  () => bulkSuspend(target, false))}>
          <PlayCircle /> Unsuspend
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="xs" disabled={busy}><Flag /> Flag</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {FLAG_NAMES.map((name, i) => (
              <DropdownMenuItem key={name}
                onClick={() => go('Flag cards', `Flag ${cards} ${name.toLowerCase()}?`,
                  () => bulkFlag(target, i + 1))}>
                <Flag style={{ color: FLAG_COLORS[i], fill: FLAG_COLORS[i] }} /> {name}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem
              onClick={() => go('Clear flags', `Remove the flag from ${cards}?`,
                () => bulkFlag(target, 0))}>
              No flag
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button variant="outline" size="xs" disabled={busy} onClick={() => setPending({ kind: 'reschedule' })}>
          <Timer /> Reschedule
        </Button>
        <Button variant="outline" size="xs" disabled={busy} onClick={() => setPending({ kind: 'tag', add: true })}>
          <Tag /> Tag
        </Button>
        <Button variant="outline" size="xs" disabled={busy} onClick={() => setPending({ kind: 'move' })}>
          <FolderInput /> Move
        </Button>
      </div>

      <BulkDialog
        pending={pending}
        target={target}
        count={count}
        decks={decks}
        onClose={() => setPending(null)}
        onRun={(op) => { setPending(null); onRun(op) }}
      />
    </div>
  )
}

function BulkDialog({
  pending, target, count, decks, onClose, onRun,
}: {
  pending: Pending | null
  target: Target
  count: number
  decks: DeckRow[]
  onClose: () => void
  onRun: (op: () => Promise<Undo>) => void
}) {
  const [days, setDays] = useState('1')
  const [tag, setTag] = useState('')
  const [deckId, setDeckId] = useState('')
  /**
   * Reschedule skips new cards, so it gets its own count rather than reusing
   * the selection's. A dialog that says 340 and moves 180 is the same lie as a
   * deck badge that says 3 due and hands over nothing.
   */
  const [reschedulable, setReschedulable] = useState<number | null>(null)

  useEffect(() => {
    if (pending?.kind !== 'reschedule') return setReschedulable(null)
    let live = true
    void targetCount(target, RESCHEDULABLE).then((n) => live && setReschedulable(n))
    return () => { live = false }
  }, [pending, target])

  if (!pending) return null
  const cards = `${count} ${count === 1 ? 'card' : 'cards'}`

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        {pending.kind === 'confirm' && (
          <>
            <DialogHeader>
              <DialogTitle>{pending.title}</DialogTitle>
              <DialogDescription>{pending.body} You can undo this.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button onClick={() => onRun(pending.op)}>{pending.title}</Button>
            </DialogFooter>
          </>
        )}

        {pending.kind === 'reschedule' && (
          <>
            <DialogHeader>
              <DialogTitle>Reschedule</DialogTitle>
              <DialogDescription>
                Sets the next due date. It does not record a review, so your history and
                your retention numbers are unchanged.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="bulk-days">Days from now</Label>
              <Input id="bulk-days" type="number" min={0} max={36500} className="w-28 font-mono"
                     value={days} onChange={(e) => setDays(e.target.value)} />
              <p className="text-xs text-muted-foreground">
                {reschedulable === null
                  ? 'Counting…'
                  : reschedulable === count
                    ? `${cards}.`
                    : `${reschedulable} of ${count} — new cards have no due date and are left alone.`}
              </p>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button disabled={!Number.isFinite(Number(days)) || !days.trim() || !reschedulable}
                      onClick={() => onRun(() => bulkReschedule(target, Number(days)))}>
                Reschedule
              </Button>
            </DialogFooter>
          </>
        )}

        {pending.kind === 'tag' && (
          <>
            <DialogHeader>
              <DialogTitle>Tags</DialogTitle>
              <DialogDescription>
                Tags live on notes, so this reaches every card of the notes you selected.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="bulk-tag">Tag</Label>
              <Input id="bulk-tag" className="font-mono" placeholder="anatomy::thorax"
                     value={tag} onChange={(e) => setTag(e.target.value.trim())} />
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button variant="outline" disabled={!tag}
                      onClick={() => onRun(() => bulkRetag(target, tag, false))}>
                Remove
              </Button>
              <Button disabled={!tag} onClick={() => onRun(() => bulkRetag(target, tag, true))}>
                Add
              </Button>
            </DialogFooter>
          </>
        )}

        {pending.kind === 'move' && (
          <>
            <DialogHeader>
              <DialogTitle>Move {cards}</DialogTitle>
              <DialogDescription>
                Moves the cards, not their notes — a note's other cards stay where they are.
              </DialogDescription>
            </DialogHeader>
            <Select value={deckId} onValueChange={setDeckId}>
              <SelectTrigger aria-label="Destination deck"><SelectValue placeholder="Choose a deck" /></SelectTrigger>
              <SelectContent>
                {decks.map((d) => <SelectItem key={d.id} value={d.id}>{d.path}</SelectItem>)}
              </SelectContent>
            </Select>
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button disabled={!deckId} onClick={() => onRun(() => bulkMove(target, deckId))}>Move</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
