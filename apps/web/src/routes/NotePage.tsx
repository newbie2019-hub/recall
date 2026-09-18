import { useEffect, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router'
import { NoteEditor } from '@/components/NoteEditor'
import { useDecks } from '@/hooks/useDecks'
import * as repo from '@/db/repo'
import { paths } from './paths'

/**
 * `/notes/:id` edits, `/decks/:deckId/notes/new` adds.
 *
 * One component for both, because the editor already treats "no note id" as the
 * add flow — and the add flow deliberately stays on the page after saving, so
 * twenty cards are one screen rather than twenty navigations (CARDS.md §1).
 */
export function NotePage({ mode }: { mode: 'new' | 'edit' }) {
  const navigate = useNavigate()
  const { noteId, deckId } = useParams()
  const { decks } = useDecks()
  const [homeDeck, setHomeDeck] = useState<string | null>(deckId ?? null)
  const [missing, setMissing] = useState(false)

  // Editing arrives by note id alone, so where "done" goes is a lookup rather
  // than a guess. `navigate(-1)` would depend on how the page was reached, and
  // a pasted link has no history behind it.
  useEffect(() => {
    if (mode !== 'edit' || !noteId) return
    void repo.getNote(noteId).then((note) => {
      note ? setHomeDeck(note.deck_id) : setMissing(true)
    })
  }, [mode, noteId])

  if (missing) return <Navigate to={paths.decks} replace />
  if (!decks) return null

  const editorDeck = homeDeck ?? decks[0]?.id
  if (!editorDeck) return <Navigate to={paths.decks} replace />

  const leave = () => navigate(homeDeck ? paths.deck(homeDeck) : paths.decks)

  return (
    <NoteEditor
      key={noteId ?? 'new'}
      noteId={mode === 'edit' ? noteId : undefined}
      deckId={editorDeck}
      decks={decks}
      onDone={leave}
      onCancel={leave}
    />
  )
}
