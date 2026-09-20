/**
 * Every URL this app answers to, in one place.
 *
 * UI.md §6 makes these a contract rather than an implementation detail: a
 * password-reset link has to land on one, marketplace decks have to be
 * shareable (Phase 8), and Phase 12's universal links must map the same path to
 * the same screen on a phone. Building them here means a rename is a compiler
 * error rather than a dead link someone finds in an email six months later.
 */
export const paths = {
  decks: '/',
  deck: (id: string) => `/decks/${id}`,
  study: (id?: string | null) => (id ? `/decks/${id}/study` : '/study'),
  newNote: (deckId: string) => `/decks/${deckId}/notes/new`,
  note: (id: string) => `/notes/${id}`,
  noteTypes: '/note-types',
  signIn: '/sign-in',
  signUp: '/sign-up',
  forgotPassword: '/forgot-password',
  resetPassword: (token: string) => `/reset/${token}`,
  settings: (section = 'profile') => `/settings/${section}`,

  // Phase 6 — the two screens heavy users live in, plus the focus timer.
  browse: '/browse',
  stats: '/stats',
  pomodoro: '/pomodoro',

  // Phase 7 — a filtered deck is a deck, so it reuses /decks/:id to study.
  // Only building the search needs a screen of its own.
  newFilteredDeck: '/decks/filtered/new',
  editFilteredDeck: (id: string) => `/decks/${id}/filter`,

  // Phase 8 — shareable, so these are the paths Phase 12's universal links
  // resolve against. A listing id is public; a deck id is not.
  marketplace: '/explore',
  listing: (id: string) => `/explore/${id}`,
  publishDeck: (deckId: string) => `/decks/${deckId}/publish`,
  myListings: '/explore/mine',
  moderation: '/moderation',
  // The published contact a takedown notice is sent to. Public, and reachable
  // without an account, because the person who needs it is usually not a user.
  legal: '/legal',
} as const

/**
 * Paths that mean something to a visitor with no account and no local
 * collection — a reset link from an email, a deck someone shared.
 *
 * **Not a guard list.** Every other path is open too: signing in is a state and
 * never a wall (PHASES §5), and nothing in this app redirects to sign-in. This
 * exists so Phase 12 knows which URLs a cold universal link must be able to
 * open, and for nothing else. If you are reading it while writing a route
 * guard, stop — the guard is the bug.
 */
export const PUBLIC_PATHS = [
  paths.signIn, paths.signUp, paths.forgotPassword, paths.marketplace, paths.legal,
] as const
