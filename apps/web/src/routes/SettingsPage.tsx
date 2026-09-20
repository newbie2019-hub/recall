import type { ReactNode } from 'react'
import { Link, Navigate, NavLink, useParams } from 'react-router'
import { ChevronLeft } from 'lucide-react'
import { Appearance } from '@/components/settings/Appearance'
import { Data } from '@/components/settings/Data'
import { Devices } from '@/components/settings/Devices'
import { Profile } from '@/components/settings/Profile'
import { Scheduling } from '@/components/settings/Scheduling'
import { Storage } from '@/components/settings/Storage'
import { cn } from '@/lib/utils'
import { paths } from './paths'

/**
 * Settings, as six sections behind `/settings/:section`.
 *
 * Each one is a URL rather than a tab component's internal state because the
 * sections are what people link each other to — "turn it off in
 * settings/storage" has to be a link, and Phase 12's universal links resolve
 * against these same paths (UI.md §6).
 */
const SECTIONS: { id: string; label: string; blurb: string; render: () => ReactNode }[] = [
  {
    id: 'profile',
    label: 'Profile',
    blurb: 'Your name, address, picture and password — and signing out.',
    render: () => <Profile />,
  },
  {
    id: 'devices',
    label: 'Devices',
    blurb: 'Every phone, tablet and browser holding a token for your account.',
    render: () => <Devices />,
  },
  {
    id: 'storage',
    label: 'Storage',
    blurb: 'What this device is holding, and what it keeps offline.',
    render: () => <Storage />,
  },
  {
    id: 'scheduling',
    label: 'Scheduling',
    blurb: 'The options a deck starts with when you make one.',
    render: () => <Scheduling />,
  },
  {
    id: 'appearance',
    label: 'Appearance',
    blurb: 'Light, dark, or whatever this device is doing.',
    render: () => <Appearance />,
  },
  {
    id: 'data',
    label: 'Data',
    blurb: 'Export, import, and deleting your account.',
    render: () => <Data />,
  },
]

export function SettingsPage() {
  const { section } = useParams()
  const current = SECTIONS.find((s) => s.id === section)

  // A stale or mistyped link lands on the first section rather than a 404: none
  // of these URLs is worth a dead end, and `replace` keeps the bad one out of
  // the back button.
  if (!current) return <Navigate to={paths.settings()} replace />

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-8">
        <Link
          to={paths.decks}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" /> Decks
        </Link>
        <h1 className="mt-2 font-display text-4xl tracking-tight">Settings</h1>
      </header>

      {/* Two columns, the sections narrow and the content wide. A row of links
          across the top read as six equal things and gave the page no shape;
          as a column they read as a table of contents, which is what they are.
          Below `sm` it falls back to a scrolling row, because a 9rem sidebar on
          a phone leaves nothing for the settings themselves. */}
      <div className="gap-10 sm:grid sm:grid-cols-[11rem_1fr]">
        <nav
          aria-label="Settings sections"
          className="mb-6 flex gap-x-1 overflow-x-auto border-b border-border pb-3 sm:sticky sm:top-20 sm:mb-0 sm:block sm:self-start sm:space-y-0.5 sm:border-0 sm:pb-0"
        >
          {SECTIONS.map((s) => (
            <NavLink
              key={s.id}
              to={paths.settings(s.id)}
              className={({ isActive }) =>
                cn(
                  'block shrink-0 rounded-md px-3 py-1.5 text-sm transition-colors',
                  isActive
                    ? 'bg-accent font-medium text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )
              }
            >
              {s.label}
            </NavLink>
          ))}
        </nav>

        <section className="min-w-0">
          <h2 className="font-display text-2xl">{current.label}</h2>
          <p className="mt-1 mb-6 text-sm text-muted-foreground">{current.blurb}</p>
          {current.render()}
        </section>
      </div>
    </div>
  )
}
