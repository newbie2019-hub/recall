import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { UserPlus } from 'lucide-react'
import type { Friend, FriendLeaderboard } from '@recall/core'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Avatar } from '@/components/Avatar'
import { useAuth } from '@/lib/auth'
import { cn } from '@/lib/utils'
import { paths } from './paths'

/**
 * The people you study alongside, and the week you have all had.
 *
 * **This is the only screen in the app that compares you to somebody else**,
 * and the rest of the product is built the other way round on purpose:
 * retention, the streak and the goal meter are all measured against your own
 * past, because peer comparison reliably helps the handful of people already
 * winning and demotivates everyone else. The product owner asked for a board,
 * so there is one — but it is the defused version.
 *
 * What that means concretely, and why each rule is here:
 *
 * - **No podium, no medals, no rank numbers, no "last place".** A rank is a
 *   verdict on a person; a count is a fact about a week. Only the counts are
 *   shown, in the order the server returns them.
 * - **Your row is marked, not crowned.** You need to find yourself in the list
 *   without the list making an event of where you are.
 * - **Reviews and minutes, never a points total.** A derived score is a number
 *   nobody can check and the first thing anyone games. These two are things
 *   that actually happened.
 * - **Seven days, never all-time.** An all-time board is unwinnable by anyone
 *   who joined late, which is everyone except the first user.
 *
 * Everything here needs the server — friendship is not a local concept — so the
 * three failure states below are the normal states, not edge cases.
 */
export function FriendsPage() {
  const { user, status, client } = useAuth()
  const [friends, setFriends] = useState<Friend[] | null>(null)
  const [board, setBoard] = useState<FriendLeaderboard | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [removing, setRemoving] = useState<Friend | null>(null)

  const offline = status === 'paused'

  const load = useCallback(async () => {
    setError(null)
    try {
      // Together, because a board naming somebody who is not in the list above
      // it reads as a bug. `friendLeaderboard` is allowed to fail on its own —
      // the friends list is the screen, the board is the flourish — so it gets
      // its own catch rather than taking the page down with it.
      const list = await client.friends()
      setFriends(list)
      setBoard(await client.friendLeaderboard(7).catch(() => null))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [client])

  useEffect(() => {
    if (user && !offline) void load()
  }, [user, offline, load])

  if (!user) {
    return (
      <div className="max-w-prose">
        <Header />
        <p className="mt-4 text-sm text-muted-foreground">
          Friends need an account — a friendship is a row on the server, so there is
          nowhere to keep one on a device studying by itself.
        </p>
        <Button asChild variant="outline" className="mt-4">
          <Link to={paths.signIn}>Sign in</Link>
        </Button>
      </div>
    )
  }

  async function act(id: string, run: () => Promise<unknown>, done: string) {
    setBusy(id)
    try {
      await run()
      toast(done)
      await load()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function invite(e: React.FormEvent) {
    e.preventDefault()
    const address = email.trim()
    if (!address) return
    await act('add', () => client.addFriend(address), `Asked ${address}. They decide.`)
    setEmail('')
  }

  const waiting = friends?.filter((f) => f.status === 'pending_in') ?? []
  const accepted = friends?.filter((f) => f.status === 'accepted') ?? []
  const sent = friends?.filter((f) => f.status === 'pending_out') ?? []

  return (
    <div>
      <Header />

      {/* Offline is its own branch rather than a spinner that never resolves:
          nothing on this screen has a local copy, so "loading" would be a lie
          told indefinitely. */}
      {offline && (
        <p className="mt-6 text-sm text-muted-foreground">
          This screen needs the network and there isn't one right now. Your cards, your
          scheduling and your reviews are unaffected — they were never on the server's
          side of this.
        </p>
      )}

      {!offline && error && (
        <div className="specimen-tag mt-6 p-6">
          <h2 className="mb-1 text-base">Can't reach your friends list</h2>
          <p className="text-sm text-muted-foreground">
            Nothing here is stored on this device, so there is nothing to fall back to.
            Studying works exactly the same either way.
          </p>
          <p className="mt-2 font-mono text-xs text-eosin">{error}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      )}

      {!offline && !error && !friends && <Skeleton className="mt-6 h-64 w-full" />}

      {!offline && !error && friends && (
        <div className="mt-8 space-y-10">
          {/* Only when there is something waiting. A permanent empty box
              advertising that people could theoretically ask to be your friend
              is worse than no box — the deck list learned this the same way. */}
          {waiting.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-medium">Waiting on you</h2>
              <ul>
                {waiting.map((f) => (
                  <li key={f.id} className="flex flex-wrap items-center gap-3 border-b border-border py-3 last:border-0">
                    <Avatar user={f.user} />
                    <p className="min-w-0 flex-1 truncate text-sm">
                      <strong className="font-medium">{f.user.name}</strong> wants to study alongside you
                    </p>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        disabled={busy === f.id}
                        onClick={() => void act(f.id, () => client.acceptFriend(f.id), `You and ${f.user.name} are friends.`)}
                      >
                        Accept
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy === f.id}
                        onClick={() => void act(f.id, () => client.removeFriend(f.id), 'Declined. They are not told.')}
                      >
                        Decline
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h2 className="mb-3 text-sm font-medium">Friends</h2>
            <ul>
              {accepted.map((f) => (
                <li key={f.id} className="flex items-center gap-3 border-b border-border py-3 last:border-0">
                  <Avatar user={f.user} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{f.user.name}</p>
                    <Presence friend={f} />
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-eosin"
                    disabled={busy === f.id}
                    onClick={() => setRemoving(f)}
                  >
                    Remove
                  </Button>
                </li>
              ))}

              {/* Not "nothing here": an empty list has to say what the thing is
                  for, or the only people who ever use it are the ones who
                  already knew. */}
              {!accepted.length && (
                <li className="py-10 text-sm text-muted-foreground">
                  Nobody yet. A friend here is somebody whose week you can see next to
                  yours — reviews and minutes for the last seven days, nothing else. They
                  never see your cards, your decks or what you got wrong.
                </li>
              )}
            </ul>
          </section>

          <section>
            <h2 className="mb-1 text-sm font-medium">Add a friend</h2>
            {/* By address, not by searching names: a name search over the
                account table is an account enumeration endpoint wearing a
                friendly hat, and nobody asked for a directory. */}
            <p className="mb-3 text-xs text-muted-foreground">
              By the email they signed up with. There is no directory to search, on
              purpose.
            </p>
            <form onSubmit={(e) => void invite(e)} className="flex max-w-md gap-2">
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="them@example.com"
                aria-label="Their email address"
                autoComplete="off"
              />
              <Button type="submit" disabled={busy === 'add' || !email.trim()}>
                <UserPlus /> Ask
              </Button>
            </form>

            {sent.length > 0 && (
              <ul className="mt-4 max-w-md">
                {sent.map((f) => (
                  <li key={f.id} className="flex items-center gap-3 border-b border-border py-2.5 last:border-0">
                    <Avatar user={f.user} className="size-6" />
                    <p className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                      {f.user.name}
                    </p>
                    <Badge variant="outline">Asked</Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy === f.id}
                      onClick={() => void act(f.id, () => client.removeFriend(f.id), 'Request withdrawn.')}
                    >
                      Cancel
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <Board board={board} />
        </div>
      )}

      <Dialog open={!!removing} onOpenChange={busy ? undefined : () => setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {removing?.user.name}?</DialogTitle>
            <DialogDescription>
              They drop off your weekly board and you drop off theirs.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Nothing else changes — no deck, no card and no review belongs to a friendship.
            Either of you can ask again afterwards.
          </p>
          <DialogFooter>
            <Button variant="ghost" disabled={!!busy} onClick={() => setRemoving(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={!!busy}
              onClick={() => {
                const f = removing
                if (!f) return
                setRemoving(null)
                void act(f.id, () => client.removeFriend(f.id), `Removed ${f.user.name}.`)
              }}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Header() {
  return (
    <header>
      <h1 className="font-display text-4xl tracking-tight">Friends</h1>
      <p className="mt-2 max-w-prose text-sm text-muted-foreground">
        A few people studying the same week as you. They see how much you reviewed — never
        what, and never how well.
      </p>
    </header>
  )
}

/**
 * Online, or when they last were.
 *
 * The dot is never the only carrier: it is filled-and-coloured beside the word
 * "Online" and a hollow ring beside a time, so colour, shape and text all say
 * the same thing (dataviz: status is colour *plus* label). The palette has no
 * green anyway, and inventing one for a presence dot would put a hue in the app
 * that exists nowhere else.
 */
function Presence({ friend }: { friend: Friend }) {
  return (
    <p className="mt-0.5 flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
      <span
        aria-hidden
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          friend.online ? 'bg-hematoxylin' : 'border border-current',
        )}
      />
      {friend.online ? 'Online' : `last seen ${lastSeen(friend.last_seen_at)}`}
    </p>
  )
}

/**
 * The week, as counts.
 *
 * The bar is scaled to the largest number on the board and carries no meaning
 * the figure beside it does not already carry — it exists so the list can be
 * read at a glance, not so anybody can be seen to be losing. There is
 * deliberately no rank, no index and no trophy.
 */
function Board({ board }: { board: FriendLeaderboard | null }) {
  if (!board) {
    return (
      <section className="border-t border-border pt-6">
        <h2 className="text-sm font-medium">This week</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The week's counts didn't load. The list above is unaffected.
        </p>
      </section>
    )
  }

  const rows = board.rows
  const peak = Math.max(1, ...rows.map((r) => r.reviews))
  const dates = `${new Date(board.period_start).toLocaleDateString()} – ${new Date(board.period_end).toLocaleDateString()}`

  return (
    <section className="border-t border-border pt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">This week</h2>
        <p className="font-mono text-xs text-muted-foreground">{dates}</p>
      </div>

      {rows.length > 1 ? (
        <ul className="mt-4 space-y-1">
          {rows.map((row) => (
            <li
              key={row.user_id}
              className={cn(
                'flex items-center gap-3 px-2 py-2',
                // Findable, not decorated. A tinted strip is enough to spot
                // your own line while scrolling; a badge-and-border treatment
                // would make the fact that you are in the list the loudest
                // thing on the screen.
                row.is_you && 'bg-accent/60',
              )}
            >
              <Avatar user={{ name: row.name, avatar: row.avatar }} className="size-6" />
              <p className="w-32 shrink-0 truncate text-sm">
                {row.name}
                {row.is_you && <span className="ml-1.5 text-xs text-muted-foreground">(you)</span>}
              </p>
              <span className="h-1 flex-1 rounded-full bg-muted" aria-hidden>
                <span
                  className="block h-full rounded-full bg-hematoxylin"
                  style={{ width: `${(row.reviews / peak) * 100}%` }}
                />
              </span>
              <p className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                {row.reviews.toLocaleString()} {row.reviews === 1 ? 'review' : 'reviews'} ·{' '}
                {row.minutes.toLocaleString()} min
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          There is nobody to put beside you yet. Add a friend and this becomes the seven
          days you have both had.
        </p>
      )}

      {/* Said out loud because the alternative is somebody quietly concluding a
          friend stopped studying when in fact their phone has not synced since
          Tuesday. The server counts the review log it has, not the one that
          exists. */}
      <p className="mt-4 font-mono text-[0.6875rem] text-muted-foreground">
        Counted from synced review logs over the last seven days — somebody who hasn't
        synced reads as behind rather than absent.
      </p>
    </section>
  )
}

/** Relative while that helps, absolute once it stops. Same shape as Devices. */
function lastSeen(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return 'unknown'
  const mins = Math.round((ms - Date.now()) / 60_000)
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (Math.abs(mins) < 60) return rtf.format(mins, 'minute')
  if (Math.abs(mins) < 60 * 24) return rtf.format(Math.round(mins / 60), 'hour')
  if (Math.abs(mins) < 60 * 24 * 14) return rtf.format(Math.round(mins / 1440), 'day')
  return new Date(ms).toLocaleDateString()
}
