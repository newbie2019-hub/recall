import { useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router'
import { Download, Filter, FolderPlus, LayoutGrid, Menu, Plus, Sparkles, Stethoscope, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { AccountMenu } from '@/components/AccountMenu'
import { FocusProvider } from '@/components/FocusTimer'
import { DeckDialog, type DeckDialogMode } from '@/components/DeckDialog'
import { useApkg } from '@/components/Apkg'
import { useActivity } from '@/hooks/useActivity'
import { refreshDecks, useDecks } from '@/hooks/useDecks'
import { cn } from '@/lib/utils'
import { paths } from '@/routes/paths'

/**
 * The chrome every in-app screen sits inside.
 *
 * Two problems, one component. **The deck list's header had grown to seven
 * outline buttons plus the account control**, all equal weight, all wrapping —
 * the app's front door looked like a toolbar. And **every page carried its own
 * `mx-auto min-h-dvh max-w-2xl px-4 py-10` wrapper**, copied about fifteen
 * times, which meant the app's width was not a decision anywhere: it was a
 * string. Both are the same missing thing.
 *
 * So: one sticky bar with a *hierarchy* — four destinations, one Create menu,
 * one account — and one `<main>` that owns the measure. Changing the width is
 * now one number in one file.
 *
 * `/study` deliberately does **not** sit inside this. The review screen is the
 * one place in the app with nothing to click but the four ratings, and a nav
 * bar across the top of it would be a feature working against itself.
 */
export function AppShell() {
  const navigate = useNavigate()
  const { decks } = useDecks()
  const [deckDialog, setDeckDialog] = useState<DeckDialogMode | null>(null)
  const apkg = useApkg({ onImported: refreshDecks })

  // Mounted once, here, because the shell is the one component every in-app
  // screen is inside. Time spent reviewing is measured per card; this is all
  // the rest of it.
  useActivity()

  const firstDeck = decks?.[0]?.id

  return (
    <FocusProvider>
     <div className="min-h-dvh">
      <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-2 px-4 sm:px-6">
          <NavLink to={paths.decks} className="font-display text-xl tracking-tight">
            Recall
          </NavLink>

          {/* Wide: the destinations are visible. Narrow: one icon, because four
              text links and a Create button do not fit a phone without one of
              them becoming unreachable. */}
          <nav className="ml-6 hidden items-center gap-1 sm:flex">
            {NAV.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end} className={navClass}>
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild className="sm:hidden">
                <Button variant="ghost" size="icon-sm" aria-label="Go to">
                  <Menu />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {NAV.map((item) => (
                  <DropdownMenuItem key={item.to} onClick={() => navigate(item.to)}>
                    {item.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={apkg.busy}>
                  <Plus /> Create
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onClick={() => setDeckDialog({ kind: 'create', parentId: null })}>
                  <FolderPlus /> New deck
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!firstDeck}
                  onClick={() => firstDeck && navigate(paths.newNote(firstDeck))}
                >
                  <Plus /> New note
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => navigate(paths.newFilteredDeck)}>
                  <Filter /> Custom study
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => navigate(paths.generate)}>
                  <Sparkles /> Cards from a document
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {/* The picker is opened from a menu item that is closing. The
                    input lives in `apkg.ui` below, outside this subtree, so the
                    click survives the unmount. */}
                <DropdownMenuItem onClick={apkg.pick}>
                  <Upload /> Import .apkg
                </DropdownMenuItem>
                <DropdownMenuItem onClick={apkg.save}>
                  <Download /> Export .apkg
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => navigate(paths.noteTypes)}>
                  <LayoutGrid /> Note types
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => navigate(paths.doctor)}>
                  <Stethoscope /> Card doctor
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <AccountMenu />
          </div>
        </div>
      </header>

      {/* No width cap here on purpose. Each screen sets its own measure, the
          way it did before this shell existed: a card browser wants the whole
          window and a page of prose does not, and one number cannot be both. */}
      <main className="w-full px-4 py-10 sm:px-6">
        <Outlet />
      </main>

      {apkg.ui}
      <DeckDialog
        mode={deckDialog}
        decks={decks ?? []}
        onClose={() => setDeckDialog(null)}
        onDone={() => {
          setDeckDialog(null)
          refreshDecks()
        }}
      />
     </div>
    </FocusProvider>
  )
}

const NAV = [
  { to: paths.decks, label: 'Decks', end: true },
  { to: paths.browse, label: 'Browse', end: false },
  { to: paths.stats, label: 'Stats', end: false },
  { to: paths.marketplace, label: 'Explore', end: false },
] as const

/** Underline rather than a filled pill: one hue, and the bar stays quiet. */
const navClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'rounded-md px-2.5 py-1.5 text-sm transition-colors hover:text-hematoxylin',
    isActive
      ? 'font-medium text-foreground underline decoration-hematoxylin decoration-2 underline-offset-[0.4rem]'
      : 'text-muted-foreground',
  )
