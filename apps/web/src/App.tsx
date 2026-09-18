import { Route, Routes } from 'react-router'
import { Toaster } from '@/components/ui/sonner'
import { AuthProvider } from '@/lib/auth'
import { DeckListPage } from '@/routes/DeckListPage'
import { DeckPage } from '@/routes/DeckPage'
import { NotePage } from '@/routes/NotePage'
import { NoteTypesPage } from '@/routes/NoteTypesPage'
import { StudyPage } from '@/routes/StudyPage'
import { NotFoundPage } from '@/routes/NotFoundPage'
import { SignInPage } from '@/routes/SignInPage'
import { SignUpPage } from '@/routes/SignUpPage'
import { ForgotPasswordPage } from '@/routes/ForgotPasswordPage'
import { ResetPasswordPage } from '@/routes/ResetPasswordPage'
import { SettingsPage } from '@/routes/SettingsPage'
import { BrowsePage } from '@/routes/BrowsePage'
import { StatsPage } from '@/routes/StatsPage'
import { PomodoroPage } from '@/routes/PomodoroPage'
import { FilteredDeckPage } from '@/routes/FilteredDeckPage'
import { MarketplacePage } from '@/routes/MarketplacePage'
import { ListingPage } from '@/routes/ListingPage'
import { PublishPage } from '@/routes/PublishPage'
import { ModerationPage } from '@/routes/ModerationPage'

/**
 * The route table.
 *
 * Adopted at the start of Phase 5, before the auth pages, so those are the first
 * screens written against a router rather than the first migrated onto one
 * (UI.md §6). The paths are a contract: a password-reset link lands on one,
 * marketplace decks are shared as one (Phase 8), and Phase 12's universal links
 * map the same path to the same screen on a phone.
 *
 * **No route is guarded.** There is no `<RequireAuth>` here and there must not
 * be one: signing in is a state, not a wall (PHASES §5), and every screen below
 * works with no account at all. The auth pages are reached *from* the deck list,
 * never placed in front of it.
 */
export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<DeckListPage />} />
        <Route path="/study" element={<StudyPage />} />
        <Route path="/decks/:deckId" element={<DeckPage />} />
        <Route path="/decks/:deckId/study" element={<StudyPage />} />
        <Route path="/decks/:deckId/notes/new" element={<NotePage mode="new" />} />
        <Route path="/notes/:noteId" element={<NotePage mode="edit" />} />
        <Route path="/note-types" element={<NoteTypesPage />} />

        {/* Phase 5 — auth and settings. */}
        <Route path="/sign-in" element={<SignInPage />} />
        <Route path="/sign-up" element={<SignUpPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset/:token" element={<ResetPasswordPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/:section" element={<SettingsPage />} />

        {/* Phase 6 — browser, dashboard, focus timer. */}
        <Route path="/browse" element={<BrowsePage />} />
        <Route path="/stats" element={<StatsPage />} />
        <Route path="/pomodoro" element={<PomodoroPage />} />

        {/* Phase 7 — filtered decks study through /decks/:id like any other. */}
        <Route path="/decks/filtered/new" element={<FilteredDeckPage mode="new" />} />
        <Route path="/decks/:deckId/filter" element={<FilteredDeckPage mode="edit" />} />

        {/* Phase 8 — marketplace. /explore is public. */}
        <Route path="/explore" element={<MarketplacePage />} />
        <Route path="/explore/:listingId" element={<ListingPage />} />
        <Route path="/decks/:deckId/publish" element={<PublishPage />} />
        <Route path="/moderation" element={<ModerationPage />} />

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
      {/* One Toaster for the whole app: mounting it per screen meant a toast
          raised just before a navigation unmounted with the screen that raised
          it. */}
      <Toaster />
    </AuthProvider>
  )
}
