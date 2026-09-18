import type { ReactNode } from 'react'
import { Link, Navigate, NavLink, useParams } from 'react-router'
import { ChevronLeft } from 'lucide-react'
import { Appearance } from '@/components/settings/Appearance'
import { Data } from '@/components/settings/Data'
import { Devices } from '@/components/settings/Devices'
import { Profile } from '@/components/settings/Profile'
import { Scheduling } from '@/components/settings/Scheduling'
import { Storage } from '@/components/settings/Storage'
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
    blurb: 'Your account on this device, and signing out of it.',
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
    <div className="mx-auto min-h-dvh max-w-2xl px-4 py-10 sm:px-6">
      <header className="mb-8">
        <Link
          to={paths.decks}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" /> Decks
        </Link>
        <h1 className="mt-2 font-display text-4xl tracking-tight">Settings</h1>
      </header>

      <nav className="mb-8 flex flex-wrap gap-x-4 gap-y-2 border-b border-border pb-3">
        {SECTIONS.map((s) => (
          <NavLink
            key={s.id}
            to={paths.settings(s.id)}
            className={({ isActive }) =>
              `text-sm ${isActive ? 'text-hematoxylin' : 'text-muted-foreground hover:text-foreground'}`
            }
          >
            {s.label}
          </NavLink>
        ))}
      </nav>

      <section>
        <h2 className="font-display text-2xl">{current.label}</h2>
        <p className="mt-1 mb-6 text-sm text-muted-foreground">{current.blurb}</p>
        {current.render()}
      </section>
    </div>
  )
}
