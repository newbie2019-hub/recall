import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Browse } from '@/components/Browse'
import { Briefing } from '@/components/stats/Briefing'
import { PresenceBar } from '@/components/collab/PresenceBar'
import { useCollabSession } from '@/hooks/useCollabSession'
import { DeckDialog, type DeckDialogMode } from '@/components/DeckDialog'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useDecks } from '@/hooks/useDecks'
import { collectionReady } from '@/db/boot'
import * as stats from '@/db/queries/stats'
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
  const [figures, setFigures] = useState<stats.DeckFigures | null>(null)

  const deck = decks?.find((d) => d.id === deckId)

  /**
   * The deck's own numbers, for the briefing below the card list.
   *
   * `Briefing` already exists and already refuses to let the model compute
   * anything — it is handed figures and can only write prose over them. The
   * only thing missing was reach: it lived on `/stats`, where the numbers are
   * the whole collection's, and "how is this deck going" is the question people
   * actually ask. Same component, same endpoint, one query's worth of figures.
   */
  useEffect(() => {
    if (!deckId) return
    setFigures(null)
    void collectionReady.then(() => stats.deckFigures(deckId)).then(setFigures)
  }, [deckId])

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
      {/* Only once there is something to say. A briefing over a deck nobody
          has reviewed would be the model guessing, which is the one thing this
          component exists to prevent. */}
      {figures && figures.tested > 0 && (
        <div className="mx-auto mt-8 max-w-3xl px-4 sm:px-6">
          <Briefing
            figures={{
              deck: figures.deck,
              cards: figures.cards,
              due_now: figures.due,
              overdue: figures.overdue,
              new_cards: figures.new,
              learning: figures.learning,
              young: figures.young,
              mature: figures.mature,
              suspended: figures.suspended,
              target_retention: Number(figures.target.toFixed(3)),
              true_retention: Number((figures.passed / figures.tested).toFixed(3)),
              recall_tests: figures.tested,
              mature_retention: figures.mature_tested
                ? Number((figures.mature_passed / figures.mature_tested).toFixed(3))
                : null,
              burden_reviews_per_day: figures.burden,
              median_seconds_per_card: Number((figures.median_answer_ms / 1000).toFixed(1)),
            }}
          />
        </div>
      )}

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
