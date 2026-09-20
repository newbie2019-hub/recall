import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Compass, Filter, FolderPlus, Layers, MoreHorizontal, Plus, RefreshCw } from 'lucide-react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { DeckDialog, type DeckDialogMode } from '@/components/DeckDialog'
import { ApkgButtons } from '@/components/Apkg'
import { AccountMenu } from '@/components/AccountMenu'
import { SyncBanner } from '@/components/SyncBanner'
import { InvitationsBanner } from '@/components/collab/InvitationsBanner'
import { useDecks } from '@/hooks/useDecks'
import { useClonedDeckUpdates } from '@/hooks/useClonedDeckUpdates'
import { paths } from './paths'

/** The front door. Never an auth wall — PLAN.md §2.6. */
export function DeckListPage() {
  const navigate = useNavigate()
  const { decks, error, reload } = useDecks()
  // Cloned decks whose publisher has shipped a newer version. An offer, never an
  // action: nothing upstream writes into a deck that has left (PHASES §8).
  const updates = useClonedDeckUpdates()
  const [deckDialog, setDeckDialog] = useState<DeckDialogMode | null>(null)

  if (error) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-3 px-6">
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
  const firstDeck = decks?.[0]?.id

  return (
    <div className="mx-auto min-h-dvh max-w-2xl px-4 py-10 sm:px-6">
      <header className="mb-10 flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-5xl tracking-tight">Recall</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {totalDue > 0 ? `${totalDue} cards waiting` : 'All caught up'}
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => setDeckDialog({ kind: 'create', parentId: null })}>
            <FolderPlus /> New deck
          </Button>
          <Button variant="outline" size="sm" onClick={() => navigate(paths.newFilteredDeck)}>
            <Filter /> Custom study
          </Button>
          <Button variant="outline" size="sm" onClick={() => navigate(paths.noteTypes)}>
            <Layers /> Note types
          </Button>
          {/* The marketplace's only way in. Before this the screens existed and
              nothing in the app linked to them. */}
          <Button variant="outline" size="sm" asChild>
            <Link to={paths.marketplace}>
              <Compass /> Explore
            </Link>
          </Button>
          <ApkgButtons onImported={() => void reload()} />
          {firstDeck && (
            <Button variant="outline" size="sm" onClick={() => navigate(paths.newNote(firstDeck))}>
              <Plus /> New note
            </Button>
          )}
          <AccountMenu />
        </div>
      </header>
      <SyncBanner />
      <InvitationsBanner onJoined={() => void reload()} />

      <ul className="mb-8">
        {decks?.map((d) => (
          <li key={d.id} className="flex items-center border-b border-border last:border-0">
            <button
              onClick={() => navigate(paths.deck(d.id))}
              className="flex flex-1 items-center gap-3 py-3 text-left hover:text-hematoxylin"
              style={{ paddingLeft: `${d.depth * 1.25}rem` }}
            >
              <span className="flex-1 text-sm">{d.name}</span>
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
          void reload()
        }}
      />
    </div>
  )
}
