/**
 * System / light / dark, applied before the first paint.
 *
 * `localStorage`, not the collection: SQLite here is async and lives behind a
 * worker, so a theme read from it lands after the first frame and every reload
 * flashes the wrong palette. It is also per-browser presentation rather than
 * collection state, so it has no business syncing to someone's other devices.
 *
 * The mechanism is the one `index.css` already declares — `.dark` on <html>,
 * `@custom-variant dark (&:is(.dark *))`. Nothing new is invented here.
 */
export type Theme = 'system' | 'light' | 'dark'

const KEY = 'recall.theme'
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)')

export function theme(): Theme {
  const stored = localStorage.getItem(KEY)
  return stored === 'light' || stored === 'dark' ? stored : 'system'
}

/** What "system" currently resolves to, so the toggle can say which one it means. */
export function resolvedTheme(choice: Theme = theme()): 'light' | 'dark' {
  return choice === 'system' ? (prefersDark.matches ? 'dark' : 'light') : choice
}

export function setTheme(choice: Theme): void {
  // Removing the key rather than storing 'system': an absent key and a browser
  // that has never had a choice made in it are the same state, and one of them
  // is not a special case.
  if (choice === 'system') localStorage.removeItem(KEY)
  else localStorage.setItem(KEY, choice)
  applyTheme()
}

export function applyTheme(): void {
  document.documentElement.classList.toggle('dark', resolvedTheme() === 'dark')
}

// "System" has to keep tracking the OS after boot — a laptop that flips at
// sunset should take the app with it, not wait for the next reload.
prefersDark.addEventListener('change', applyTheme)

// Applied on import rather than from a component, because a component renders
// after the first frame and that frame is the flash this file exists to prevent.
applyTheme()
