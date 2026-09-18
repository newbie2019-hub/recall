/**
 * Phase 6 — the dashboard.
 *
 * PHASES.md sets the bar at "it tells you something Anki's stats never did", so
 * the screen is ordered by what it can tell you rather than by chart type: the
 * headline is true retention against the target the user asked for, then the
 * weaknesses it can name, then the load coming at them, and only then the
 * history. A heatmap and a streak are at the bottom because they are the part
 * Anki already has.
 *
 * Every figure above the fold is a query over the append-only `reviews` log
 * (`db/queries/stats.ts`), which is why they can be trusted: the `cards` table
 * is a cache an undo or a replay can move, the log is what actually happened.
 */
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Forecast, Heatmap, RetentionMeter, Tile, TimeOfDay } from '@/components/stats/charts'
import { Leeches, WorstTopics } from '@/components/stats/Weaknesses'
import { collectionReady } from '@/db/boot'
import * as stats from '@/db/queries/stats'
import { paths } from './paths'

const RANGES = [
  { id: '30', label: '30 days', days: 30 },
  { id: '90', label: '90 days', days: 90 },
  { id: '365', label: 'This year', days: 365 },
  { id: 'all', label: 'All time', days: 36_500 },
] as const

interface Data {
  retention: stats.RetentionRow[]
  topics: stats.TopicRow[]
  forecast: stats.ForecastDay[]
  days: stats.DayCount[]
  hours: stats.HourRow[]
  leeches: stats.LeechRow[]
}

export function StatsPage() {
  const navigate = useNavigate()
  const [range, setRange] = useState<(typeof RANGES)[number]['id']>('365')
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)

  const days = RANGES.find((r) => r.id === range)!.days

  const load = useCallback(async () => {
    try {
      await collectionReady
      // Six independent reads against one worker; issuing them together lets
      // the worker queue them instead of paying six round-trip latencies.
      const [retention, topics, forecast, daily, hours, leeches] = await Promise.all([
        stats.retention(days),
        stats.worstTopics(days),
        stats.forecast(28),
        stats.daily(365),
        stats.byHour(days),
        stats.leeches(),
      ])
      setData({ retention, topics, forecast, days: daily, hours, leeches })
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [days])

  useEffect(() => void load(), [load])

  const applyLeech = async (row: stats.LeechRow) => {
    await stats.applyLeech(row)
    await load()
  }

  if (error)
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-3 px-6">
        <h1 className="font-display text-3xl">Can't read your history</h1>
        <p className="font-mono text-xs text-eosin">{error}</p>
        <Button variant="outline" className="mt-2 self-start" onClick={() => navigate(paths.decks)}>
          All decks
        </Button>
      </div>
    )

  return (
    <div className="mx-auto min-h-dvh max-w-3xl px-4 py-10 sm:px-6">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <Button variant="ghost" size="sm" className="-ml-2 mb-1" onClick={() => navigate(paths.decks)}>
            <ArrowLeft /> Decks
          </Button>
          <h1 className="font-display text-4xl tracking-tight">Stats</h1>
        </div>
        <Tabs value={range} onValueChange={(v) => setRange(v as typeof range)}>
          <TabsList>
            {RANGES.map((r) => (
              <TabsTrigger key={r.id} value={r.id}>{r.label}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </header>

      {!data ? (
        <div className="space-y-6">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <Dashboard data={data} onApplyLeech={applyLeech} />
      )}
    </div>
  )
}

function Dashboard({ data, onApplyLeech }: { data: Data; onApplyLeech: (r: stats.LeechRow) => void }) {
  const tested = data.retention.reduce((s, d) => s + d.tested, 0)
  const passed = data.retention.reduce((s, d) => s + d.passed, 0)
  const matureTested = data.retention.reduce((s, d) => s + d.mature_tested, 0)
  const maturePassed = data.retention.reduce((s, d) => s + d.mature_passed, 0)
  // One collection-wide target does not exist, so the honest headline compares
  // against what the decks were actually asked for, weighted by how much of
  // your reviewing each one is.
  const target = tested
    ? data.retention.reduce((s, d) => s + d.target * d.tested, 0) / tested
    : 0.9

  const streak = stats.streak(data.days)
  const today = data.days.at(-1)
  const weekLoad = data.forecast.slice(0, 7).reduce((s, d) => s + d.due, 0)

  if (!tested)
    return (
      <p className="border-t border-border py-10 text-sm text-muted-foreground">
        Nothing to show yet. These figures come from the review log, and a card has
        to be answered at least a day after it was last seen before it counts as a
        test of memory rather than a learning step.
      </p>
    )

  return (
    <div className="space-y-10">
      {/* ── the headline: is the scheduler delivering what was asked for ── */}
      <section className="border-t border-border pt-4">
        <h2 className="mb-3 text-sm font-medium">True retention</h2>
        <RetentionMeter
          hero
          label={`across ${tested.toLocaleString()} recall tests`}
          achieved={passed / tested}
          target={target}
          tested={tested}
        />
        <p className="mt-3 text-sm text-muted-foreground">
          {passed / tested < target - 0.02
            ? 'Below the target these decks were set to. FSRS is doing what it was asked; the request is too optimistic, so intervals are running longer than your memory does. Lower the target and the intervals shorten to match.'
            : passed / tested > target + 0.04
              ? 'Comfortably above target — you are reviewing more often than you need to. Raising the target buys back reviews at the same recall.'
              : 'Landing on target. The schedule is honest.'}
        </p>
        <div className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          <Tile
            label="Mature cards"
            value={matureTested ? `${((maturePassed / matureTested) * 100).toFixed(0)}%` : '—'}
            note={`${matureTested.toLocaleString()} tests past 21 days`}
          />
          <Tile label="Streak" value={`${streak}`} note={streak === 1 ? 'day' : 'days'} />
          <Tile
            label="Today"
            value={(today?.reviews ?? 0).toLocaleString()}
            note="reviews answered"
          />
          <Tile label="Next 7 days" value={weekLoad.toLocaleString()} note="reviews due" />
        </div>
      </section>

      {data.retention.length > 1 && (
        <section className="border-t border-border pt-4">
          <h2 className="mb-1 text-sm font-medium">Retention by deck</h2>
          <p className="mb-4 text-xs text-muted-foreground">
            Worst gap first. The tick is the target; the bar is what the log says you got.
          </p>
          <div className="grid gap-5 sm:grid-cols-2">
            {data.retention.map((d) => (
              <RetentionMeter
                key={d.deck_id}
                label={d.deck}
                achieved={d.passed / d.tested}
                target={d.target}
                tested={d.tested}
              />
            ))}
          </div>
        </section>
      )}

      {/* ── weaknesses, named ── */}
      <section className="border-t border-border pt-4">
        <h2 className="mb-1 text-sm font-medium">Worst topics</h2>
        <p className="mb-2 text-xs text-muted-foreground">
          Lapse rate per tag, rolled up the tree — a parent counts everything under it.
        </p>
        <WorstTopics topics={data.topics} />
      </section>

      <section className="border-t border-border pt-4">
        <h2 className="mb-1 text-sm font-medium">Leeches, and why</h2>
        <p className="mb-2 text-xs text-muted-foreground">
          Eight lapses is a symptom. The sentence under each card is what the review log
          says is actually wrong with it.
        </p>
        <Leeches rows={data.leeches} onApply={onApplyLeech} />
      </section>

      {/* ── the load coming at you ── */}
      <Forecast days={data.forecast} />

      {/* ── habit: the part Anki already has ── */}
      <TimeOfDay hours={data.hours} />
      <Heatmap days={data.days} streak={streak} />
    </div>
  )
}
