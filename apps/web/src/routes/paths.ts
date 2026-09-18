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
} as const
