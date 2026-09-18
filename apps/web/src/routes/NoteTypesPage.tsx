import { useNavigate } from 'react-router'
import { NoteTypes } from '@/components/NoteTypes'
import { useDecks } from '@/hooks/useDecks'
import { paths } from './paths'

export function NoteTypesPage() {
  const navigate = useNavigate()
  const { decks } = useDecks()

  return <NoteTypes decks={decks ?? []} onBack={() => navigate(paths.decks)} />
}
