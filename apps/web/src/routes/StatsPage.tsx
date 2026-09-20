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
import {
  Activity, ArrowLeft, Bug, CalendarClock, Clock, Flame, Gauge, Hourglass,
  Layers, Target, TrendingUp,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  AnswerTimeHistogram, Composition, Forecast, Heatmap, RankedBars, RetentionMeter,
  Tile, TimeHeatmap, TimeOfDay, duration,
} from '@/components/stats/charts'
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
  minutes: stats.DayTime[]
  decks: stats.DeckTime[]
  times: stats.AnswerTimes
  buttons: stats.ButtonCounts
  counts: stats.CardCounts
  load: stats.Workload
  app: { appMs: number; reviewMs: number }
}

/**
 * Three views, because one scroll of everything below is a wall.
 *
 * The split is by *question*, not by chart type: "am I remembering this"
 * (Progress), "what is it costing me" (Effort), "what is the collection made
 * of" (Collection). Anything that answers two of them is drawn once, on the tab
 * where it is the answer rather than the context.
 */
const VIEWS = [
  { id: 'progress', label: 'Progress' },
  { id: 'effort', label: 'Effort' },
  { id: 'collection', label: 'Collection' },
] as const

export function StatsPage() {
  const navigate = useNavigate()
  const [range, setRange] = useState<(typeof RANGES)[number]['id']>('365')
  const [view, setView] = useState<(typeof VIEWS)[number]['id']>('progress')
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)

  const days = RANGES.find((r) => r.id === range)!.days

  const load = useCallback(async () => {
    try {
      await collectionReady
      // Independent reads against one worker; issuing them together lets the
      // worker queue them rather than paying a round-trip latency each.
      const [
        retention, topics, forecast, daily, hours, leeches,
        minutes, decks, times, buttons, counts, load, app,
      ] = await Promise.all([
        stats.retention(days),
        stats.worstTopics(days),
        stats.forecast(28),
        stats.daily(365),
        stats.byHour(days),
        stats.leeches(),
        stats.timeByDay(365),
        stats.timeByDeck(days),
        stats.answerTimes(days),
        stats.answerButtons(days),
        stats.cardCounts(),
        stats.workload(),
        stats.appTime(7),
      ])
      setData({
        retention, topics, forecast, days: daily, hours, leeches,
        minutes, decks, times, buttons, counts, load, app,
      })
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
      <div className="mx-auto flex max-w-md flex-col justify-center gap-3 py-20">
        <h1 className="font-display text-3xl">Can't read your history</h1>
        <p className="font-mono text-xs text-eosin">{error}</p>
        <Button variant="outline" className="mt-2 self-start" onClick={() => navigate(paths.decks)}>
          All decks
        </Button>
      </div>
    )

  return (
    <div className="mx-auto w-full max-w-5xl">
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

      <Tabs value={view} onValueChange={(v) => setView(v as typeof view)} className="mb-8">
        <TabsList>
          {VIEWS.map((v) => (
            <TabsTrigger key={v.id} value={v.id}>{v.label}</TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {!data ? (
        <div className="space-y-6">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <Dashboard data={data} view={view} onApplyLeech={applyLeech} />
      )}
    </div>
  )
}

function Dashboard({
  data, view, onApplyLeech,
}: {
  data: Data
  view: (typeof VIEWS)[number]['id']
  onApplyLeech: (r: stats.LeechRow) => void
}) {
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

  // Only *Progress* needs a review history. What the collection is made of and
  // what it will cost are answerable on day one — and on day one they are the
  // more useful pair, since the decision in front of somebody with no history
  // is how many cards to take on.
  if (!tested && view === 'progress')
    return (
      <div className="space-y-4 border-t border-border py-10">
        <p className="text-sm text-muted-foreground">
          Nothing to show here yet. These figures come from the review log, and a card
          has to be answered at least a day after it was last seen before it counts as a
          test of memory rather than a learning step.
        </p>
        <p className="text-sm text-muted-foreground">
          <strong className="font-medium text-foreground">Collection</strong> works
          already — it is what you are holding and what it will cost you per day.
        </p>
      </div>
    )

  return (
    <div className="space-y-10">
      {/* ── the headline: is the scheduler delivering what was asked for ── */}
      {view === 'progress' && (
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
            icon={Target}
            label="Mature cards"
            value={matureTested ? `${((maturePassed / matureTested) * 100).toFixed(0)}%` : '—'}
            note={`${matureTested.toLocaleString()} tests past 21 days`}
            help="Recall on cards whose interval has passed 21 days. Anki's boundary, so the number means the same thing coming from there."
          />
          <Tile
            icon={Flame}
            label="Streak"
            value={`${streak}`}
            note={streak === 1 ? 'day' : 'days'}
            help="Consecutive days with at least one review. Counted from your own history, not from a goal you have to keep."
          />
          <Tile
            icon={Activity}
            label="Today"
            value={(today?.reviews ?? 0).toLocaleString()}
            note="reviews answered"
            help="Everything answered since midnight, learning steps included."
          />
          <Tile
            icon={CalendarClock}
            label="Next 7 days"
            value={weekLoad.toLocaleString()}
            note="reviews due"
            help="What the scheduler has already planned. It moves as you answer — every review reschedules the card that produced it."
          />
        </div>
      </section>
      )}

      {view === 'progress' && data.retention.length > 1 && (
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
      {view === 'progress' && (
      <section className="border-t border-border pt-4">
        <h2 className="mb-1 text-sm font-medium">Worst topics</h2>
        <p className="mb-2 text-xs text-muted-foreground">
          Lapse rate per tag, rolled up the tree — a parent counts everything under it.
        </p>
        <WorstTopics topics={data.topics} />
      </section>
      )}

      {view === 'progress' && (
      <section className="border-t border-border pt-4">
        <h2 className="mb-1 flex items-center gap-1.5 text-sm font-medium">
          <Bug className="size-3.5 text-muted-foreground" /> Leeches, and why
        </h2>
        <p className="mb-2 text-xs text-muted-foreground">
          Not a lapse count. Each of these fails more often than the scheduler predicted it
          would, and the sentence underneath is what the log says is wrong with it.
        </p>
        <Leeches rows={data.leeches} onApply={onApplyLeech} />
      </section>
      )}

      {view === 'progress' && <Forecast days={data.forecast} />}
      {view === 'progress' && <Heatmap days={data.days} streak={streak} />}

      {view === 'effort' && <Effort data={data} />}
      {view === 'collection' && <Collection data={data} />}
    </div>
  )
}

/**
 * What the collection costs.
 *
 * Time sits here rather than on the headline on purpose. It is a weak and
 * unstable predictor of learning, it is gamed by leaving the app open, and for
 * a fluent learner it runs backwards — knowing a card better means answering it
 * faster. What it is honest about is *cost*, which is the question the
 * retention figure cannot answer.
 */
function Effort({ data }: { data: Data }) {
  const week = data.minutes.slice(-7).reduce((s, d) => s + d.ms, 0)
  const todayMs = data.minutes.at(-1)?.ms ?? 0
  const lifetime = data.minutes.reduce((s, d) => s + d.ms, 0)
  const { appMs, reviewMs } = data.app

  return (
    <>
      <section className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        <Tile
          icon={Clock}
          label="Today"
          value={duration(todayMs)}
          note="answering cards"
          help="Time with a card actually in front of you. The clock stops for a hidden tab and for idle time, and one answer is capped by the deck's longest-answer setting."
        />
        <Tile
          icon={TrendingUp}
          label="This week"
          value={duration(week)}
          note="over 7 days"
          help="Compared against your own past, never against anybody else's."
        />
        <Tile
          icon={Hourglass}
          label="Per card"
          value={data.times.total ? `${(data.times.median / 1000).toFixed(1)}s` : '—'}
          note="median"
          help="The median, not the mean: one sixty-second answer drags an average and tells you nothing about a typical card."
        />
        <Tile
          icon={Gauge}
          label="In the app"
          value={appMs ? `${Math.round((reviewMs / appMs) * 100)}%` : '—'}
          note={appMs ? `${duration(reviewMs)} of ${duration(appMs)} reviewing` : 'no sessions yet'}
          help="How much of your time in the app was spent answering cards rather than browsing, editing or reading this screen."
        />
      </section>

      <TimeHeatmap days={data.minutes} />

      <RankedBars
        title="Where the time goes"
        hint={`by deck · ${duration(data.decks.reduce((s, d) => s + d.ms, 0))} in this window`}
        rows={data.decks.map((d) => ({
          label: d.deck,
          value: d.ms,
          note: `${d.reviews.toLocaleString()} cards`,
        }))}
        format={duration}
      />

      <AnswerTimeHistogram {...data.times} />
      <TimeOfDay hours={data.hours} />

      <p className="border-t border-border pt-4 text-xs text-muted-foreground">
        All of it comes from the review log, which records how long each card was on screen
        with the clock paused for hidden tabs and idle time. Lifetime: {duration(lifetime)}.
      </p>
    </>
  )
}

/**
 * What the collection is made of, and what it has committed you to.
 *
 * **Burden** is the number worth the screen space: summing `1/interval` across
 * every scheduled card gives the reviews a day the collection costs at a steady
 * state, forever. It is what makes "I added two hundred cards today" visible as
 * a decision rather than an achievement, and nothing in Anki shows it.
 */
function Collection({ data }: { data: Data }) {
  const { counts, load } = data
  const total = counts.new + counts.learning + counts.young + counts.mature + counts.suspended

  return (
    <>
      <section className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        <Tile
          icon={Layers}
          label="Cards"
          value={total.toLocaleString()}
          note={`${counts.mature.toLocaleString()} mature`}
          help="Every card in the collection, suspended ones included."
        />
        <Tile
          icon={Gauge}
          label="Burden"
          value={load.burden ? load.burden.toFixed(1) : '—'}
          note="reviews a day, forever"
          help="The sum of 1/interval across every scheduled card: what this collection costs you per day at a steady state. A card on a 100-day interval contributes 0.01."
        />
        <Tile
          icon={Clock}
          label="Daily cost"
          value={load.dailyMs ? duration(load.dailyMs) : '—'}
          note="at your answering speed"
          help="Burden multiplied by how long your answers actually take. This is what adding cards signs you up for."
        />
        <Tile
          icon={CalendarClock}
          label="Overdue"
          value={load.overdue.toLocaleString()}
          note={load.overdue ? `median ${load.medianDaysLate}d late` : 'nothing owed'}
          help="Cards past their due date right now. A backlog is not a failure — but the longer a card waits, the less the interval it was given means."
        />
      </section>

      <Composition
        title="What the collection is made of"
        hint={`${total.toLocaleString()} cards · mature is an interval past 21 days`}
        parts={[
          { label: 'New', value: counts.new, step: 1 },
          { label: 'Learning', value: counts.learning, step: 2 },
          { label: 'Young', value: counts.young, step: 3 },
          { label: 'Mature', value: counts.mature, step: 5 },
          { label: 'Suspended', value: counts.suspended, step: 0 },
        ]}
      />

      <Composition
        title="Which buttons you press"
        hint="recall tests only — a relearning step ten minutes later is not a test"
        parts={[
          { label: 'Again', value: data.buttons.again, step: 1 },
          { label: 'Hard', value: data.buttons.hard, step: 2 },
          { label: 'Good', value: data.buttons.good, step: 4 },
          { label: 'Easy', value: data.buttons.easy, step: 5 },
        ]}
      />

      <Forecast days={data.forecast} />
    </>
  )
}
