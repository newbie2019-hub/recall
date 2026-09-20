import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Browse } from '@/components/Browse'
import { PresenceBar } from '@/components/collab/PresenceBar'
import { useCollabSession } from '@/hooks/useCollabSession'
import { DeckDialog, type DeckDialogMode } from '@/components/DeckDialog'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useDecks } from '@/hooks/useDecks'
import { paths } from './paths'

export function DeckPage() {
  const navigate = useNavigate()
  const { deckId } = useParams()
  const { decks, reload } = useDecks()
  // A live session when the deck is shared, idle otherwise. It is opened here
  // as well as in the editor so that edits arriving while you are *looking* at
  // the card list land in the list (PHASES §9: one source of truth).
  const collab = useCollabSession(deckId)
  const [deckDialog, setDeckDialog] = useState<DeckDialogMode | null>(null)

  const deck = decks?.find((d) => d.id === deckId)

  if (!decks) {
    return (
      <div className="mx-auto max-w-2xl space-y-3">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  // A URL can name a deck that has since been deleted, or that belongs to a
  // collection this device no longer holds. Say so rather than rendering a
  // blank screen.
  if (!deck) {
    return (
      <div className="mx-auto flex max-w-md flex-col justify-center gap-3 py-20">
        <h1 className="font-display text-3xl">No such deck</h1>
        <p className="text-sm text-muted-foreground">
          It may have been deleted, or this link came from another device.
        </p>
        <Button variant="outline" className="mt-2 self-start" onClick={() => navigate(paths.decks)}>
          All decks
        </Button>
      </div>
    )
  }

  return (
    <>
      {collab.status !== 'idle' && (
        <div className="mx-auto max-w-3xl px-4 pt-6 sm:px-6">
          <PresenceBar
            members={collab.members}
            status={collab.status}
            queued={collab.session?.queued ?? 0}
          />
        </div>
      )}
      <Browse
        key={collab.revision}
        deck={deck}
        onBack={() => navigate(paths.decks)}
        onOpen={(noteId) => navigate(paths.note(noteId))}
        onNew={() => navigate(paths.newNote(deck.id))}
        onStudy={() => navigate(paths.study(deck.id))}
        onEditDeck={() => setDeckDialog({ kind: 'edit', deck })}
        onDeleteDeck={() => setDeckDialog({ kind: 'delete', deck })}
        onNewSubdeck={() => setDeckDialog({ kind: 'create', parentId: deck.id })}
        onShare={() => navigate(paths.share(deck.id))}
      />
      <DeckDialog
        mode={deckDialog}
        decks={decks}
        onClose={() => setDeckDialog(null)}
        onDone={(nextDeckId) => {
          setDeckDialog(null)
          void reload()
          // A deleted deck has nowhere to go back to.
          navigate(nextDeckId ? paths.deck(nextDeckId) : paths.decks)
        }}
      />
    </>
  )
}
