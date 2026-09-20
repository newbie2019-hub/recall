import { Route, Routes } from 'react-router'
import { Toaster } from '@/components/ui/sonner'
import { AuthProvider } from '@/lib/auth'
import { AppShell } from '@/components/AppShell'
import { RequireAuth } from '@/components/RequireAuth'
import { useSync } from '@/hooks/useSync'
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
import { MyListingsPage } from '@/routes/MyListingsPage'
import { LegalPage } from '@/routes/LegalPage'
import { SharePage } from '@/routes/SharePage'
import { WelcomePage } from '@/routes/WelcomePage'
import { DoctorPage } from '@/routes/DoctorPage'

/**
 * The route table.
 *
 * Adopted at the start of Phase 5, before the auth pages, so those are the first
 * screens written against a router rather than the first migrated onto one
 * (UI.md §6). The paths are a contract: a password-reset link lands on one,
 * marketplace decks are shared as one (Phase 8), and Phase 12's universal links
 * map the same path to the same screen on a phone.
 *
 * **The table has three tiers, and the nesting is the point.**
 *
 * 1. *Bare* — the auth pages. No chrome, no account, no collection.
 * 2. *Inside `AppShell`* — the nav bar and the 1280px measure. `/explore`, a
 *    listing and `/legal` sit here **without** `RequireAuth`, because a shared
 *    deck is handed to people who do not have an account yet; they get the
 *    chrome with "Sign in" in the account slot.
 * 3. *Inside `RequireAuth`* — everything else.
 *
 * `/welcome` and the two study routes are guarded but deliberately **outside**
 * the shell: onboarding should not offer an escape hatch it has not earned, and
 * the review screen is the one place in the app with nothing to click but the
 * four ratings.
 *
 * This reverses what this comment said until now — that no route is guarded and
 * none ever should be. Signing in is a wall as of this change; what survives
 * from that older rule is that a *failed* sign-in never is. See
 * `components/RequireAuth.tsx`.
 */
export default function App() {
  return (
    <AuthProvider>
      <Sync />
      <Routes>
        {/* Phase 5 — the way in. Deliberately unchromed: a sign-in page with a
            nav bar offers destinations nobody can reach yet. */}
        <Route path="/sign-in" element={<SignInPage />} />
        <Route path="/sign-up" element={<SignUpPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset/:token" element={<ResetPasswordPage />} />

        {/* Guarded, but without the shell. */}
        <Route element={<RequireAuth />}>
          <Route path="/welcome" element={<WelcomePage />} />
          <Route path="/welcome/:step" element={<WelcomePage />} />
          <Route path="/study" element={<StudyPage />} />
          <Route path="/decks/:deckId/study" element={<StudyPage />} />
        </Route>

        <Route element={<AppShell />}>
          {/* Public, and staying that way — a listing is shared with people who
              do not have an account yet. */}
          <Route path="/explore" element={<MarketplacePage />} />
          {/* Static segment first: react-router ranks it above `:listingId`
              anyway, and the order here says so out loud. */}
          <Route path="/explore/:listingId" element={<ListingPage />} />
          <Route path="/legal" element={<LegalPage />} />

          <Route element={<RequireAuth />}>
            <Route path="/" element={<DeckListPage />} />
            <Route path="/decks/:deckId" element={<DeckPage />} />
            <Route path="/decks/:deckId/notes/new" element={<NotePage mode="new" />} />
            <Route path="/notes/:noteId" element={<NotePage mode="edit" />} />
            <Route path="/note-types" element={<NoteTypesPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/settings/:section" element={<SettingsPage />} />

            {/* Phase 6 — browser, dashboard, focus timer. */}
            <Route path="/browse" element={<BrowsePage />} />
            <Route path="/doctor" element={<DoctorPage />} />
            <Route path="/stats" element={<StatsPage />} />
            <Route path="/pomodoro" element={<PomodoroPage />} />

            {/* Phase 7 — filtered decks study through /decks/:id like any other. */}
            <Route path="/decks/filtered/new" element={<FilteredDeckPage mode="new" />} />
            <Route path="/decks/:deckId/filter" element={<FilteredDeckPage mode="edit" />} />

            {/* Phase 8 — publishing and the shelf are an account's own. */}
            <Route path="/explore/mine" element={<MyListingsPage />} />
            <Route path="/decks/:deckId/publish" element={<PublishPage />} />
            <Route path="/moderation" element={<ModerationPage />} />

            {/* Phase 9 — live collaboration. The document itself has no route:
                it is the deck screen, which becomes live when shared. */}
            <Route path="/decks/:deckId/share" element={<SharePage />} />
          </Route>
        </Route>

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
      {/* One Toaster for the whole app: mounting it per screen meant a toast
          raised just before a navigation unmounted with the screen that raised
          it. */}
      <Toaster />
    </AuthProvider>
  )
}

/**
 * The sync loop, mounted once and rendering nothing.
 *
 * It lives in its own component rather than in `App` because the hook needs to
 * be *inside* `AuthProvider` to read the session, and a component cannot use a
 * context it provides itself.
 */
function Sync() {
  useSync()
  return null
}
