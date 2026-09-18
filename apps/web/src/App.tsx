import { Route, Routes } from 'react-router'
import { Toaster } from '@/components/ui/sonner'
import { DeckListPage } from '@/routes/DeckListPage'
import { DeckPage } from '@/routes/DeckPage'
import { NotePage } from '@/routes/NotePage'
import { NoteTypesPage } from '@/routes/NoteTypesPage'
import { StudyPage } from '@/routes/StudyPage'
import { NotFoundPage } from '@/routes/NotFoundPage'

/**
 * The route table.
 *
 * Adopted at the start of Phase 5, before the auth pages, so those are the first
 * screens written against a router rather than the first migrated onto one
 * (UI.md §6). The paths are a contract: a password-reset link lands on one,
 * marketplace decks are shared as one (Phase 8), and Phase 12's universal links
 * map the same path to the same screen on a phone.
 */
export default function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<DeckListPage />} />
        <Route path="/study" element={<StudyPage />} />
        <Route path="/decks/:deckId" element={<DeckPage />} />
        <Route path="/decks/:deckId/study" element={<StudyPage />} />
        <Route path="/decks/:deckId/notes/new" element={<NotePage mode="new" />} />
        <Route path="/notes/:noteId" element={<NotePage mode="edit" />} />
        <Route path="/note-types" element={<NoteTypesPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
      {/* One Toaster for the whole app: mounting it per screen meant a toast
          raised just before a navigation unmounted with the screen that raised
          it. */}
      <Toaster />
    </>
  )
}
