import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { formatSearch, parseSearch, setFacet } from '@recall/core'
import { BulkBar } from '@/components/browse/BulkBar'
import { CardTable } from '@/components/browse/CardTable'
import { CardInfoDialog } from '@/components/CardInfoDialog'
import { TagSidebar } from '@/components/browse/TagSidebar'
import { FilterBar } from '@/components/browse/FilterBar'
import { Button } from '@/components/ui/button'
import { collectionReady } from '@/db/boot'
import {
  browseCards, browseCount, tagTree,
  type BrowseCard, type SortKey, type TagNode, type Target, type Undo,
} from '@/db/queries/browse'
import { useDecks } from '@/hooks/useDecks'
import { paths } from './paths'

const PAGE = 100

/**
 * The global card browser — every card in the collection, not one deck's.
 *
 * `components/Browse.tsx` is the per-deck note list and stays that: it is the
 * deck's own screen, with the deck's options row and its "new note" button, and
 * it lists *notes* where this lists *cards*. See the report — the two could be
 * merged by making that one render `<BrowsePage search={`deck:${name}`} />`,
 * but that is a change to a file this phase does not own.
 */
export function BrowsePage() {
  const navigate = useNavigate()
  const { decks } = useDecks()

  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<{ by: SortKey; dir: 'asc' | 'desc' }>({ by: 'due', dir: 'asc' })
  const [page, setPage] = useState(0)
  const [rows, setRows] = useState<BrowseCard[] | null>(null)
  const [total, setTotal] = useState(0)
  const [tags, setTags] = useState<TagNode[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /**
   * Two kinds of selection, and the difference is the whole point.
   *
   * `sel` is ticked ids. They survive a filter change untouched — a card you
   * ticked is still that card whatever the list now shows, and losing a
   * selection because you narrowed the search is the behaviour everyone hates.
   *
   * `allMatching` is "every card this search returns", and it is *cleared* on a
   * filter change, because it was a promise about a set that no longer exists.
   * Keeping it would silently re-aim a pending suspend at a different 4,000
   * cards.
   */
  const [sel, setSel] = useState<ReadonlySet<string>>(new Set())
  const [infoFor, setInfoFor] = useState<string | null>(null)
  const [allMatching, setAllMatching] = useState(false)

  const terms = useMemo(() => parseSearch(search), [search])

  const reload = useCallback(async () => {
    try {
      await collectionReady
      // Count and page come from the same compiled search, in one round trip,
      // so the header can never advertise a number the list disagrees with.
      const [r, n] = await Promise.all([
        browseCards(terms, sort.by, sort.dir, PAGE, page * PAGE),
        browseCount(terms),
      ])
      setRows(r)
      setTotal(n)
      setError(null)
    } catch (e) {
      // A dead database must never look like an empty collection.
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [terms, sort, page])

  const reloadTags = useCallback(async () => {
    await collectionReady
    setTags(await tagTree())
  }, [])

  useEffect(() => void reload(), [reload])
  useEffect(() => void reloadTags(), [reloadTags])
  // Suspending the last page's worth of cards leaves the page index past the
  // end of a shorter result. Walk back rather than showing an empty table.
  useEffect(() => {
    const last = Math.max(0, Math.ceil(total / PAGE) - 1)
    if (page > last) setPage(last)
  }, [total, page])

  const apply = (next: string) => {
    if (next === search) return
    setSearch(next)
    setPage(0)
    setAllMatching(false)
  }

  const target: Target = allMatching ? { terms } : { ids: [...sel] }
  const count = allMatching ? total : sel.size

  /**
   * Run a bulk operation, then offer the undo it handed back.
   *
   * ponytail: the undo lives in the toast's closure, so it dies with the toast
   * and with the tab — one level, no history. A persisted undo stack is a
   * different feature (and the review log already has its own); build it when
   * someone asks to undo the operation before last.
   */
  const run = (op: () => Promise<Undo>) => {
    setBusy(true)
    void (async () => {
      try {
        const undo = await op()
        await Promise.all([reload(), reloadTags()])
        if (!undo.count) return void toast('Nothing to change.')
        toast.success(`${undo.label} ${undo.count} ${undo.noun}${undo.count === 1 ? '' : 's'}`, {
          duration: 12_000,
          // Delete offers no button. An Undo that does nothing is a promise
          // somebody will rely on exactly once.
          action: undo.undoable === false ? undefined : {
            label: 'Undo',
            onClick: () => void undo.run().then(() => Promise.all([reload(), reloadTags()])),
          },
        })
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    })()
  }

  /**
   * Ticking anything by hand ends "all matching": the two cannot both be true,
   * and the ticks are the more recent statement of what the person means.
   */
  const tick = (add: string[], remove: string[]) => {
    setAllMatching(false)
    setSel((s) => {
      const next = new Set(s)
      for (const id of add) next.add(id)
      for (const id of remove) next.delete(id)
      return next
    })
  }

  const activeTag = terms.find((t) => t.kind === 'tag' && !t.neg)?.value ?? ''
  const pages = Math.max(1, Math.ceil(total / PAGE))

  return (
    <main className="mx-auto w-full max-w-7xl">
      <header className="mb-5 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-display text-4xl tracking-tight">Browse</h1>
        <div className="flex items-center gap-3">
          <p className="font-mono text-[0.6875rem] text-muted-foreground">
            {total.toLocaleString()} {total === 1 ? 'card' : 'cards'}
          </p>
          <Button variant="ghost" size="sm" onClick={() => navigate(paths.decks)}>All decks</Button>
        </div>
      </header>

      <div className="mb-4">
        <FilterBar search={search} terms={terms} decks={decks ?? []} onSearch={apply} />
      </div>

      {error && (
        <p className="mb-4 rounded-sm border border-destructive px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex gap-6">
        <TagSidebar
          tags={tags}
          active={activeTag}
          onPick={(tag) => apply(formatSearch(setFacet(terms, 'tag', tag)))}
        />

        <div className="min-w-0 flex-1">
          {count > 0 && (
            <BulkBar
              target={target} count={count} total={total} allMatching={allMatching}
              decks={decks ?? []} busy={busy} onRun={run}
              onSelectAll={() => setAllMatching(true)}
              onClear={() => { setSel(new Set()); setAllMatching(false) }}
            />
          )}

          <CardTable
            rows={rows}
            selected={sel}
            sort={sort}
            onSort={(by) => setSort((s) => ({ by, dir: s.by === by && s.dir === 'asc' ? 'desc' : 'asc' }))}
            onToggle={(id, on) => tick(on ? [id] : [], on ? [] : [id])}
            onTogglePage={(on) => {
              const ids = (rows ?? []).map((r) => r.id)
              tick(on ? ids : [], on ? [] : ids)
            }}
            onOpen={(noteId) => navigate(paths.note(noteId))}
            onInfo={setInfoFor}
          />

          <CardInfoDialog cardId={infoFor} onClose={() => setInfoFor(null)} />

          {pages > 1 && (
            <div className="flex items-center justify-center gap-3 py-4">
              <Button variant="ghost" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                <ChevronLeft /> Previous
              </Button>
              <span className="font-mono text-[0.6875rem] text-muted-foreground">
                {page + 1} / {pages}
              </span>
              <Button variant="ghost" size="sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
                Next <ChevronRight />
              </Button>
            </div>
          )}
        </div>
      </div>
    </main>
  )
}
