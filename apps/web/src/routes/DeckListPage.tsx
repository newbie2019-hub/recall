import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { ChevronRight, MoreHorizontal, RefreshCw } from 'lucide-react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { DeckDialog, type DeckDialogMode } from '@/components/DeckDialog'
import { WeekActivity } from '@/components/stats/charts'
import { SyncBanner } from '@/components/SyncBanner'
import { InvitationsBanner } from '@/components/collab/InvitationsBanner'
import { collectionReady } from '@/db/boot'
import * as stats from '@/db/queries/stats'
import { refreshDecks, useDecks } from '@/hooks/useDecks'
import { useClonedDeckUpdates } from '@/hooks/useClonedDeckUpdates'
import { cn } from '@/lib/utils'
import { paths } from './paths'

/**
 * The front door.
 *
 * It used to carry the whole app in its header — seven outline buttons and the
 * account control, wrapping onto two rows on a laptop. Every one of them now
 * lives in `AppShell`, and what is left here is what the screen is actually
 * about: how much is waiting, the decks, and the button that starts studying.
 */
export function DeckListPage() {
  const navigate = useNavigate()
  const { decks, error, reload } = useDecks()
  // Cloned decks whose publisher has shipped a newer version. An offer, never an
  // action: nothing upstream writes into a deck that has left (PHASES §8).
  const updates = useClonedDeckUpdates()
  const [deckDialog, setDeckDialog] = useState<DeckDialogMode | null>(null)
  const [collapsed, toggleDeck] = useCollapsedDecks()
  const [history, setHistory] = useState<stats.DayCount[] | null>(null)
  const [mastery, setMastery] = useState<Map<string, stats.Mastery>>(new Map)

  /**
   * The week, and how much of each deck is still in there.
   *
   * Of every add-on in the Anki ecosystem the review heatmap is the most
   * installed by a wide margin, and it is not installed for the analysis — it
   * is installed to be seen on the way in. This started as a year of it under
   * the Study button and is now seven cells above the decks, which is the
   * question you actually have on the way in: did I study today.
   *
   * A full year is still fetched, because the streak has to be right however
   * long it runs and only the display is a week.
   */
  useEffect(() => {
    void collectionReady.then(() => Promise.all([stats.daily(365), stats.masteryByDeck()]))
      .then(([days, m]) => { setHistory(days); setMastery(m) })
  }, [])

  if (error) {
    return (
      <div className="mx-auto flex max-w-md flex-col justify-center gap-3 py-20">
        <h1 className="font-display text-3xl">Can't open your collection</h1>
        <p className="text-sm text-muted-foreground">
          Your cards are safe on this device — the app just couldn't reach them.
        </p>
        <p className="font-mono text-xs text-eosin">{error}</p>
        <Button variant="outline" className="mt-2 self-start" onClick={() => location.reload()}>
          Try again
        </Button>
      </div>
    )
  }

  // Counts on a parent are rolled up from its whole subtree, so the totals live
  // on the roots — adding the children again would count every card twice.
  const totalDue = decks?.filter((d) => !d.parent_id).reduce((s, d) => s + d.due + d.new, 0) ?? 0

  // Which decks have children, and which rows are hidden because an ancestor is
  // folded. The tree arrives flat and in path order, so one pass over it in
  // order is enough — a parent is always seen before anything under it.
  const parents = new Set((decks ?? []).map((d) => d.parent_id).filter(Boolean) as string[])
  const hidden = new Set<string>()
  for (const d of decks ?? []) {
    if (d.parent_id && (hidden.has(d.parent_id) || collapsed.has(d.parent_id))) hidden.add(d.id)
  }
  const visible = (decks ?? []).filter((d) => !hidden.has(d.id))

  return (
    <div>
      <header className="mb-10">
        <h1 className="font-display text-5xl tracking-tight">Recall</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {totalDue > 0 ? `${totalDue} cards waiting` : 'All caught up'}
        </p>
      </header>
      {/* Above the decks, because it is the thing you glance at on the way in
          rather than something you go looking for. */}
      {history && (
        <Link to={paths.stats} className="mb-8 block w-fit hover:opacity-90">
          <WeekActivity days={history} streak={stats.streak(history)} />
        </Link>
      )}

      <SyncBanner />
      <InvitationsBanner onJoined={() => void reload()} />

      <ul className="mb-8">
        {visible.map((d) => (
          <li key={d.id} className="flex items-center border-b border-border last:border-0">
            {/* The chevron is its own control, not part of the deck link:
                folding a deck and opening it are different intentions, and a
                parent you cannot open is worse than one you cannot fold. */}
            <span className="flex w-5 shrink-0 justify-center" style={{ marginLeft: `${d.depth * 1.25}rem` }}>
              {parents.has(d.id) && (
                <button
                  onClick={() => toggleDeck(d.id)}
                  aria-expanded={!collapsed.has(d.id)}
                  aria-label={`${collapsed.has(d.id) ? 'Expand' : 'Collapse'} ${d.name}`}
                  className="-m-1 p-1 text-muted-foreground hover:text-foreground"
                >
                  <ChevronRight
                    className={cn('size-3.5 transition-transform', !collapsed.has(d.id) && 'rotate-90')}
                  />
                </button>
              )}
            </span>
            <button
              onClick={() => navigate(paths.deck(d.id))}
              className="flex flex-1 items-center gap-3 py-3 text-left hover:text-hematoxylin"
            >
              <span className="flex-1 text-sm">{d.name}</span>
              <DeckMastery of={mastery.get(d.id)} />
              {d.due > 0 && (
                <Badge variant="outline" className="font-mono text-[0.625rem] text-hematoxylin">
                  {d.due} due
                </Badge>
              )}
              {d.new > 0 && (
                <Badge variant="outline" className="font-mono text-[0.625rem] text-eosin">
                  {d.new} new
                </Badge>
              )}
            </button>
            {updates.has(d.id) && (
              <Link
                to={paths.listing(updates.get(d.id)!.listingId)}
                className="mr-1 flex items-center gap-1 font-mono text-[0.625rem] text-hematoxylin hover:underline"
                title={`The publisher has v${updates.get(d.id)!.latestVersion}. Your scheduling is kept.`}
              >
                <RefreshCw className="size-3" />v{updates.get(d.id)!.latestVersion}
              </Link>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={`${d.name} options`}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setDeckDialog({ kind: 'create', parentId: d.id })}>
                  New subdeck
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setDeckDialog({ kind: 'edit', deck: d })}>
                  Rename or move
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => navigate(paths.share(d.id))}>
                  Share…
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => navigate(paths.publishDeck(d.id))}>
                  Publish…
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => navigate(paths.doctorFor(d.id))}>
                  Check the cards…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => setDeckDialog({ kind: 'delete', deck: d })}>
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        ))}
        {decks && !decks.length && (
          <li className="py-14 text-center text-sm text-muted-foreground">
            No decks yet. Make one and start adding cards.
          </li>
        )}
      </ul>

      <Button size="lg" className="w-full" disabled={!totalDue} onClick={() => navigate(paths.study())}>
        {totalDue ? 'Study now' : 'Nothing due'}
      </Button>

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
  )
}

/**
 * Which decks are folded shut.
 *
 * `localStorage`, not SQLite: this is how *this browser* is looking at the
 * collection right now, not a fact about the collection. Putting it in the
 * database would sync it, and a deck you folded on a laptop would fold itself
 * on your phone mid-review.
 *
 * Counts on a folded parent stay correct without any work here — they are
 * already rolled up from the whole subtree, which is why the totals live on the
 * roots.
 */
/**
 * How much of this deck the model thinks is still in there.
 *
 * Σ R over the deck's cards, so "74%" means *about three quarters of these you
 * could answer right now* rather than "three quarters are older than
 * twenty-one days" — a threshold reads the same for a deck of twenty-two-day
 * intervals and a deck of ninety-day ones.
 *
 * It is a model output and the title says so, pointing at the calibration
 * chart: if the scheduler is running optimistic for this person, so is this,
 * by about the same amount. A number derived from a fit has to be reachable
 * from the check on that fit, or it is just a confident-looking percentage.
 *
 * Hidden under twenty cards. A deck of three says nothing, and a big round
 * percentage over a handful of cards is the kind of number people remember and
 * quote back.
 */
function DeckMastery({ of }: { of?: stats.Mastery }) {
  if (!of || of.cards < 20) return null
  const share = of.remembered / of.cards

  return (
    <span
      className="hidden font-mono text-[0.625rem] text-muted-foreground tabular-nums sm:inline"
      title={`About ${Math.round(of.remembered).toLocaleString()} of ${of.cards.toLocaleString()} cards recallable right now. `
        + 'An estimate from the scheduler — Stats › Progress shows how well it is calling it.'}
    >
      {Math.round(share * 100)}%
    </span>
  )
}

const KEY = 'recall.collapsed_decks'

function useCollapsedDecks(): [Set<string>, (id: string) => void] {
  const [ids, setIds] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[])
    } catch {
      return new Set()
    }
  })

  const toggle = (id: string) =>
    setIds((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      try {
        localStorage.setItem(KEY, JSON.stringify([...next]))
      } catch {
        // A blocked or full storage costs the memory of the fold, never the fold.
      }
      return next
    })

  return [ids, toggle]
}
