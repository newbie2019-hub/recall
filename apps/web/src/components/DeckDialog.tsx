import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import * as repo from '@/db/repo'
import { DECK_SEP, safeDeckName } from '@recall/core'

/**
 * Create, rename, move and delete a deck.
 *
 * One dialog for all four because they are the same two fields — a name and a
 * parent — and splitting them would mean three components that drift apart.
 * Delete is the exception and states what it takes with it, because it is the
 * only one that cannot be undone.
 */

const ROOT = '— none, top level —'

export type DeckDialogMode =
  | { kind: 'create'; parentId: string | null }
  | { kind: 'edit'; deck: repo.DeckRow }
  | { kind: 'delete'; deck: repo.DeckRow }

export function DeckDialog({
  mode,
  decks,
  onClose,
  onDone,
}: {
  mode: DeckDialogMode | null
  decks: repo.DeckRow[]
  onClose: () => void
  onDone: (deckId?: string) => void
}) {
  const editing = mode?.kind === 'edit' ? mode.deck : null
  const [name, setName] = useState('')
  const [parent, setParent] = useState<string>(ROOT)
  const [contents, setContents] = useState<{ decks: number; notes: number; cards: number } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!mode) return
    setBusy(false)
    setContents(null)
    if (mode.kind === 'create') {
      setName('')
      setParent(mode.parentId ?? ROOT)
    } else if (mode.kind === 'edit') {
      setName(mode.deck.name)
      setParent(mode.deck.parent_id ?? ROOT)
    } else {
      void repo.deckContents(mode.deck.id).then(setContents)
    }
  }, [mode])

  if (!mode) return null

  // A deck cannot be moved inside its own subtree; offering the option and then
  // rejecting it is worse than not offering it.
  const ownSubtree = editing
    ? new Set(decks.filter((d) => d.path.startsWith(editing.path)).map((d) => d.id))
    : new Set<string>()

  const clean = safeDeckName(name)
  const stripped = clean !== name.trim()

  async function submit() {
    if (!clean || busy) return
    setBusy(true)
    try {
      const parentId = parent === ROOT ? null : parent
      if (mode!.kind === 'create') {
        const deckId = await repo.createDeck(clean, parentId)
        toast(`Created ${clean}`)
        onDone(deckId)
      } else if (mode!.kind === 'edit') {
        const deck = (mode as { deck: repo.DeckRow }).deck
        if (clean !== deck.name) await repo.renameDeck(deck.id, clean)
        if (parentId !== deck.parent_id) await repo.moveDeck(deck.id, parentId)
        toast('Deck updated')
        onDone(deck.id)
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  async function remove() {
    const deck = (mode as { deck: repo.DeckRow }).deck
    setBusy(true)
    await repo.deleteDeck(deck.id)
    toast(`Deleted ${deck.name}`)
    onDone()
  }

  if (mode.kind === 'delete')
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {mode.deck.name}?</DialogTitle>
            <DialogDescription>
              {contents
                ? contents.notes === 0
                  ? 'This deck is empty.'
                  : `This removes ${contents.notes} note${contents.notes === 1 ? '' : 's'} and ` +
                    `${contents.cards} card${contents.cards === 1 ? '' : 's'}` +
                    (contents.decks > 1 ? `, and ${contents.decks - 1} subdeck${contents.decks === 2 ? '' : 's'}` : '') +
                    '. Your review history is kept.'
                : 'Counting…'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>Keep it</Button>
            <Button variant="again" disabled={busy || !contents} onClick={() => void remove()}>
              Delete deck
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode.kind === 'create' ? 'New deck' : `Edit ${editing!.name}`}</DialogTitle>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="deck-name" className="text-[0.625rem] tracking-[0.14em] text-muted-foreground uppercase">
            Name
          </Label>
          <Input
            id="deck-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
            placeholder="Pharmacology"
          />
          {stripped && (
            <p className="text-xs text-muted-foreground">
              Saved as “{clean}”. <code className="font-mono">{DECK_SEP}</code> separates
              parent from child, so it cannot be part of one deck’s name.
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="deck-parent" className="text-[0.625rem] tracking-[0.14em] text-muted-foreground uppercase">
            Inside
          </Label>
          <Select value={parent} onValueChange={setParent}>
            <SelectTrigger id="deck-parent" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ROOT}>{ROOT}</SelectItem>
              {decks
                .filter((d) => !ownSubtree.has(d.id))
                .map((d) => <SelectItem key={d.id} value={d.id}>{d.path}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!clean || busy} onClick={() => void submit()}>
            {mode.kind === 'create' ? 'Create deck' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
