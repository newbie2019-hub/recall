import type { Session } from '@recall/core'
import { cn } from '@/lib/utils'

/**
 * A person, as a small round picture.
 *
 * **Drawn here, not uploaded.** An upload means a bucket, a moderation
 * problem, an image-processing dependency and somebody's actual face attached
 * to a marketplace listing they did not realise was public. Twelve SVGs in a
 * file cost none of that, weigh nothing, inherit the theme's colours, and
 * cannot be anything other than what they are.
 *
 * The account stores a *key* (`users.avatar`), so an unknown one — an old
 * client, a key we later retire — falls back to initials rather than to a
 * broken image. Initials are also what a new account gets, which is why they
 * are a real branch rather than a placeholder.
 */

export const AVATARS = [
  'fox', 'owl', 'cat', 'frog', 'bear', 'whale',
  'axolotl', 'bee', 'mushroom', 'cactus', 'moon', 'heart',
] as const

export type AvatarKey = (typeof AVATARS)[number]

export const isAvatarKey = (value: unknown): value is AvatarKey =>
  typeof value === 'string' && (AVATARS as readonly string[]).includes(value)

export function Avatar({
  user, className, avatar,
}: {
  user: Pick<Session['user'], 'name' | 'avatar'>
  className?: string
  /** Override the stored key, for previewing a choice before it is saved. */
  avatar?: string | null
}) {
  const key = avatar === undefined ? user.avatar : avatar

  return (
    <span
      aria-hidden
      className={cn(
        'grid size-7 shrink-0 place-items-center overflow-hidden rounded-full bg-muted',
        className,
      )}
    >
      {isAvatarKey(key) ? (
        <AvatarArt name={key} />
      ) : (
        <span className="font-mono text-[0.625rem] tracking-wider text-muted-foreground">
          {initials(user.name)}
        </span>
      )}
    </span>
  )
}

/**
 * The pictures.
 *
 * One 32×32 viewBox each, flat shapes, no gradients and no strokes thinner than
 * a pixel at the size these are actually drawn — 28px in the app bar. `--h3`
 * and `--h4` come from the same ramp the charts use, so an avatar cannot
 * introduce a colour the rest of the app does not already have.
 */
export function AvatarArt({ name, className }: { name: AvatarKey; className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn('size-full', className)}
      style={{ ['--a' as string]: '#6c61a2', ['--b' as string]: '#ada6c6', ['--c' as string]: '#2a2154' }}
    >
      <rect width="32" height="32" fill="var(--b)" opacity="0.35" />
      {ART[name]}
    </svg>
  )
}

const eyes = (
  <>
    <circle cx="12.5" cy="17" r="1.5" fill="var(--c)" />
    <circle cx="19.5" cy="17" r="1.5" fill="var(--c)" />
  </>
)

const ART: Record<AvatarKey, React.ReactNode> = {
  fox: (
    <>
      <path d="M6 10l4 6-3 1z M26 10l-4 6 3 1z" fill="var(--a)" />
      <path d="M16 8c6 0 9 5 9 10s-4 7-9 7-9-2-9-7 3-10 9-10z" fill="var(--a)" />
      <path d="M16 20c2 0 4 1 4 3s-2 3-4 3-4-1-4-3 2-3 4-3z" fill="var(--b)" />
      {eyes}
    </>
  ),
  owl: (
    <>
      <path d="M16 7c6 0 10 4 10 10s-4 9-10 9S6 22 6 17 10 7 16 7z" fill="var(--a)" />
      <circle cx="12.5" cy="16" r="4" fill="var(--b)" />
      <circle cx="19.5" cy="16" r="4" fill="var(--b)" />
      <circle cx="12.5" cy="16" r="1.8" fill="var(--c)" />
      <circle cx="19.5" cy="16" r="1.8" fill="var(--c)" />
      <path d="M16 19l2 3h-4z" fill="var(--c)" />
    </>
  ),
  cat: (
    <>
      <path d="M7 9l3 6-4 1z M25 9l-3 6 4 1z" fill="var(--a)" />
      <ellipse cx="16" cy="18" rx="9" ry="8" fill="var(--a)" />
      {eyes}
      <path d="M16 20l1.5 2h-3z" fill="var(--c)" />
      <path d="M8 19h4 M24 19h-4" stroke="var(--c)" strokeWidth="0.8" opacity="0.6" />
    </>
  ),
  frog: (
    <>
      <circle cx="11" cy="12" r="4.5" fill="var(--a)" />
      <circle cx="21" cy="12" r="4.5" fill="var(--a)" />
      <circle cx="11" cy="12" r="1.8" fill="var(--c)" />
      <circle cx="21" cy="12" r="1.8" fill="var(--c)" />
      <path d="M16 14c6 0 9 3 9 7s-4 5-9 5-9-1-9-5 3-7 9-7z" fill="var(--a)" />
      <path d="M11 22q5 3 10 0" stroke="var(--c)" strokeWidth="1.2" fill="none" strokeLinecap="round" />
    </>
  ),
  bear: (
    <>
      <circle cx="8.5" cy="10.5" r="3.5" fill="var(--a)" />
      <circle cx="23.5" cy="10.5" r="3.5" fill="var(--a)" />
      <circle cx="16" cy="18" r="9" fill="var(--a)" />
      <ellipse cx="16" cy="21" rx="4.5" ry="3.5" fill="var(--b)" />
      {eyes}
      <circle cx="16" cy="20" r="1.3" fill="var(--c)" />
    </>
  ),
  whale: (
    <>
      <path d="M4 18c0-4 5-7 11-7s13 3 13 7-6 7-13 7S4 22 4 18z" fill="var(--a)" />
      <path d="M28 18l3-4v8z" fill="var(--a)" />
      <path d="M13 9c0-2 2-3 3-4-1 3 1 3 1 5" stroke="var(--b)" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      <circle cx="11" cy="17" r="1.5" fill="var(--c)" />
      <path d="M8 22q6 3 14 0" stroke="var(--b)" strokeWidth="1.2" fill="none" strokeLinecap="round" />
    </>
  ),
  axolotl: (
    <>
      <path d="M6 12l4 4-4 3z M26 12l-4 4 4 3z" fill="var(--b)" />
      <path d="M9 10l3 5-4 1z M23 10l-3 5 4 1z" fill="var(--b)" />
      <ellipse cx="16" cy="18" rx="8" ry="7.5" fill="var(--a)" />
      {eyes}
      <path d="M13 21q3 2 6 0" stroke="var(--c)" strokeWidth="1.2" fill="none" strokeLinecap="round" />
    </>
  ),
  bee: (
    <>
      <ellipse cx="11" cy="12" rx="4" ry="5" fill="var(--b)" opacity="0.7" />
      <ellipse cx="21" cy="12" rx="4" ry="5" fill="var(--b)" opacity="0.7" />
      <ellipse cx="16" cy="18" rx="7" ry="8" fill="var(--a)" />
      <path d="M9.6 15.5h12.8 M9.4 20h13.2" stroke="var(--c)" strokeWidth="2" opacity="0.7" />
      <circle cx="13.5" cy="13.5" r="1.2" fill="var(--c)" />
      <circle cx="18.5" cy="13.5" r="1.2" fill="var(--c)" />
    </>
  ),
  mushroom: (
    <>
      <path d="M5 16c0-6 5-9 11-9s11 3 11 9z" fill="var(--a)" />
      <circle cx="11" cy="12" r="1.8" fill="var(--b)" />
      <circle cx="20" cy="11" r="2.2" fill="var(--b)" />
      <path d="M12 16h8v7a4 4 0 01-8 0z" fill="var(--b)" />
      <circle cx="14" cy="19" r="1" fill="var(--c)" />
      <circle cx="18" cy="19" r="1" fill="var(--c)" />
    </>
  ),
  cactus: (
    <>
      <rect x="13" y="8" width="6" height="18" rx="3" fill="var(--a)" />
      <path d="M13 15H9a2 2 0 00-2 2v2a2 2 0 002 2h4z" fill="var(--a)" />
      <path d="M19 12h4a2 2 0 012 2v3a2 2 0 01-2 2h-4z" fill="var(--a)" />
      <circle cx="15" cy="16" r="1" fill="var(--c)" />
      <circle cx="18" cy="16" r="1" fill="var(--c)" />
      <path d="M9 27h14" stroke="var(--c)" strokeWidth="1.6" strokeLinecap="round" opacity="0.5" />
    </>
  ),
  moon: (
    <>
      <path d="M21 5a12 12 0 100 22A13 13 0 0121 5z" fill="var(--a)" />
      <circle cx="12" cy="13" r="1.4" fill="var(--c)" />
      <circle cx="12" cy="20" r="1" fill="var(--c)" opacity="0.6" />
      <path d="M26 8l1 2 2 1-2 1-1 2-1-2-2-1 2-1z" fill="var(--b)" />
    </>
  ),
  heart: (
    <>
      <path
        d="M16 26S5 19 5 13a6 6 0 0111-3.2A6 6 0 0127 13c0 6-11 13-11 13z"
        fill="var(--a)"
      />
      <circle cx="12.5" cy="14" r="1.3" fill="var(--c)" />
      <circle cx="19.5" cy="14" r="1.3" fill="var(--c)" />
      <path d="M13.5 18q2.5 2 5 0" stroke="var(--c)" strokeWidth="1.2" fill="none" strokeLinecap="round" />
    </>
  ),
}

export function initials(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => [...part][0] ?? '')
    .join('')

  // An account named with an emoji or a single glyph still needs something in
  // the circle, and a blank one reads as "not signed in".
  return letters.toUpperCase() || '·'
}
