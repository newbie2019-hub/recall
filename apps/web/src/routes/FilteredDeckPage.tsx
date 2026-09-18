import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import * as filtered from '@/db/queries/filtered'
import {
  DEFAULT_FILTER, FILTER_ORDERS, type FilterConfig, type FilterOrder,
} from '@recall/core'
import { paths } from './paths'

/**
 * Build a filtered deck — Anki's custom study.
 *
 * There is no session screen because there is no session: a filtered deck is a
 * deck row with a search attached, so it is studied at `/decks/:id/study` like
 * every other deck. This page only exists to write the search down.
 */

const ORDER_LABEL: Record<FilterOrder, string> = {
  due: 'Oldest due first',
  random: 'Random',
  lapses: 'Most lapses first',
}

export function FilteredDeckPage({ mode }: { mode: 'new' | 'edit' }) {
  const navigate = useNavigate()
  const { deckId } = useParams()
  const [name, setName] = useState('Custom study')
  const [cfg, setCfg] = useState<FilterConfig>(DEFAULT_FILTER)
  const [held, setHeld] = useState(0)
  const [matches, setMatches] = useState<number | null>(null)
  const [loading, setLoading] = useState(mode === 'edit')
  const [missing, setMissing] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (mode === 'new' || !deckId) return
    const deck = await filtered.getFilteredDeck(deckId)
    if (!deck) return setMissing(true)
    setName(deck.name)
    setCfg(deck.config)
    setHeld(deck.cards)
    setLoading(false)
  }, [mode, deckId])

  useEffect(() => void load(), [load])

  // The count the build will actually deliver, re-asked as you type. Debounced
  // because every keystroke is a scan of the collection, and 200ms after the
  // last one is soon enough to feel live.
  useEffect(() => {
    if (loading) return
    setMatches(null)
    const t = setTimeout(
      () => void filtered.matchCount(cfg, deckId ?? null).then(setMatches),
      200,
    )
    return () => clearTimeout(t)
  }, [cfg, deckId, loading])

  const act = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const build = () =>
    act(async () => {
      if (mode === 'new') {
        const id = await filtered.createFilteredDeck(name, cfg)
        navigate(paths.deck(id))
      } else {
        const n = await filtered.saveFilteredDeck(deckId!, name, cfg)
        toast(`${n} card${n === 1 ? '' : 's'} in ${name}`)
        navigate(paths.deck(deckId!))
      }
    })

  if (missing) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-3 px-6">
        <h1 className="font-display text-3xl">No such filtered deck</h1>
        <p className="text-sm text-muted-foreground">
          It may have been emptied and deleted, or this link came from another device.
        </p>
        <Button variant="outline" className="mt-2 self-start" onClick={() => navigate(paths.decks)}>
          All decks
        </Button>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="mx-auto min-h-dvh max-w-xl space-y-3 px-4 py-10 sm:px-6">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    )
  }

  const field = 'text-[0.625rem] tracking-[0.14em] text-muted-foreground uppercase'

  return (
    <div className="mx-auto min-h-dvh max-w-xl px-4 py-10 sm:px-6">
      <header className="mb-8">
        <h1 className="font-display text-4xl tracking-tight">
          {mode === 'new' ? 'Custom study' : name}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Borrow cards into a temporary deck. They go home when you empty it — with
          their schedules intact.
        </p>
      </header>

      <div className="space-y-6">
        <div className="space-y-1.5">
          <Label htmlFor="cram-name" className={field}>Name</Label>
          <Input
            id="cram-name"
            autoFocus={mode === 'new'}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Exam cram"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="cram-search" className={field}>Search</Label>
          <Input
            id="cram-search"
            value={cfg.search}
            onChange={(e) => setCfg({ ...cfg, search: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && void build()}
            placeholder="tag:exam is:due"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground">
            <code className="font-mono">deck: tag: is: flag: lapses: due:</code> — the
            same search as the browser. Empty takes the whole collection.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="cram-limit" className={field}>Card limit</Label>
            {/* Native number input: the platform already has the stepper, the
                keypad on a phone and the validation. */}
            <Input
              id="cram-limit"
              type="number"
              min={1}
              max={9999}
              value={cfg.limit}
              onChange={(e) => setCfg({ ...cfg, limit: Number(e.target.value) || 1 })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cram-order" className={field}>Order</Label>
            <Select
              value={cfg.order}
              onValueChange={(v) => setCfg({ ...cfg, order: v as FilterOrder })}
            >
              <SelectTrigger id="cram-order" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {FILTER_ORDERS.map((o) => (
                  <SelectItem key={o} value={o}>{ORDER_LABEL[o]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex items-start gap-3 border-y border-border py-4">
          <Switch
            id="cram-reschedule"
            checked={cfg.reschedule}
            onCheckedChange={(v) => setCfg({ ...cfg, reschedule: v })}
          />
          <div className="space-y-1">
            <Label htmlFor="cram-reschedule" className="text-sm">Reschedule cards</Label>
            {/* Says exactly what it costs. "Reschedule off" that quietly logged a
                review would be a promise broken by the next cache rebuild. */}
            <p className="text-xs text-muted-foreground">
              {cfg.reschedule
                ? 'Answers count: the card is scheduled as usual, using its home deck’s retention target.'
                : 'A pure cram. Answers change nothing — and are not recorded in your review history at all.'}
            </p>
          </div>
        </div>

        <p className="font-mono text-xs text-muted-foreground tabular-nums">
          {matches === null
            ? 'Counting…'
            : `${matches} card${matches === 1 ? '' : 's'} will be pulled in`}
          {mode === 'edit' && held > 0 && ` · ${held} in the deck now`}
        </p>

        <div className="flex flex-wrap gap-2">
          <Button disabled={busy || matches === null} onClick={() => void build()}>
            {mode === 'new' ? 'Build deck' : 'Rebuild'}
          </Button>
          <Button variant="ghost" onClick={() => navigate(mode === 'edit' && deckId ? paths.deck(deckId) : paths.decks)}>
            Cancel
          </Button>
          {mode === 'edit' && (
            <>
              <Button
                variant="outline"
                className="ml-auto"
                disabled={busy || held === 0}
                onClick={() =>
                  void act(async () => {
                    await filtered.emptyFilteredDeck(deckId!)
                    toast(`${held} card${held === 1 ? '' : 's'} sent home`)
                    setBusy(false)
                    await load()
                  })
                }
              >
                Empty
              </Button>
              {/* No confirmation: deleting a filtered deck deletes nothing. The
                  cards go home first, and rebuilding recreates it. */}
              <Button
                variant="again"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await filtered.deleteFilteredDeck(deckId!)
                    toast(`Deleted ${name}. Its cards are back in their own decks.`)
                    navigate(paths.decks)
                  })
                }
              >
                Delete
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
