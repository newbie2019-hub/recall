/**
 * The dashboard's charts. Inline SVG, no chart library.
 *
 * UI.md §4 names shadcn's `Chart` (Recharts) here, but Recharts is not
 * installed and none of these five forms need it: a heatmap is a grid of
 * `<rect>`, a column chart is a loop, and a meter is two rectangles. Adding
 * ~90kB of runtime and a second styling system to draw them would be the
 * "shadcn defaults" trap one layer down, which is the very thing UI.md warns
 * about in that section. If a Phase 9 chart ever needs real axes and brushing,
 * install it then and keep these.
 *
 * Every rule below comes from the `dataviz` skill: thin marks, a 4px rounded
 * data-end square at the baseline, a 2px surface gap between neighbours,
 * hairline recessive gridlines, one sequential hue, and text that never wears
 * the data colour.
 */
import { useState, type ComponentType, type ReactNode } from 'react'
import { Flame } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CalibrationBin } from '@recall/core'
import type { DayCount, ForecastDay, HourRow, MemorisedDay } from '@/db/queries/stats'

/**
 * The sequential ramp, light→dark, one hue (hematoxylin).
 *
 * Both modes were generated and then *validated* with the dataviz palette
 * checker rather than eyeballed: monotone lightness, every adjacent ΔL ≥ 0.06,
 * and the light end at 2.20:1 (light) / 2.27:1 (dark) against the card surface,
 * clear of the 2:1 floor. Dark is its own ramp, not an inversion of light — the
 * anchor flips, so `--h1` is still "least" in both.
 */
const RAMP = [
  '[--h1:#ada6c6] [--h2:#8e85b5] [--h3:#6c61a2] [--h4:#4a3d8f] [--h5:#2a2154]',
  'dark:[--h1:#56507c] dark:[--h2:#6c639e] dark:[--h3:#8278c1] dark:[--h4:#9b8fe8] dark:[--h5:#cfc7f5]',
].join(' ')

const pct = (n: number) => `${(n * 100).toFixed(n >= 0.995 || n <= -0.995 ? 0 : 1)}%`
const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`

/**
 * A chart, its title, and a readout line that doubles as the hover tooltip.
 *
 * One `pointerover` on the container beats a tooltip component per chart: any
 * mark that carries `data-label` becomes hoverable, the text lands in a fixed
 * slot so nothing reflows, and there is no floating layer to collide with the
 * viewport edge on a phone.
 *
 * ponytail: pointer only — the marks are not focusable, because 365 tab stops
 * on a heatmap is worse than none. `aria-label` on each chart carries the
 * summary for a screen reader, and the two lists below carry the detail. Add
 * roving-tabindex if someone asks to explore a chart by keyboard.
 */
export function Figure({
  title, hint, className, children,
}: { title: string; hint: string; className?: string; children: ReactNode }) {
  const [label, setLabel] = useState<string | null>(null)
  return (
    <section className={cn('border-t border-border pt-4', RAMP, className)}>
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="mt-0.5 mb-3 h-4 font-mono text-xs text-muted-foreground">{label ?? hint}</p>
      <div
        onPointerOver={(e) => setLabel((e.target as Element).getAttribute('data-label'))}
        onPointerLeave={() => setLabel(null)}
      >
        {children}
      </div>
    </section>
  )
}

// ── the hero: true retention against the target that was asked for ─────────

/**
 * The number that tells someone their settings are wrong.
 *
 * A meter rather than a gauge: the fill is the measurement, the tick is the
 * promise, and the gap between them is the whole message. Below target the fill
 * turns eosin — and it never carries the meaning alone, the delta is spelled
 * out in text beside it (dataviz: status is colour *plus* label, never colour).
 */
export function RetentionMeter({
  label, achieved, target, tested, hero = false,
}: { label: string; achieved: number; target: number; tested: number; hero?: boolean }) {
  // No tests means no rate. `0 / 0` is `NaN`, and a meter that renders "NaN%"
  // at full width is worse than one that admits it has nothing to say — which
  // is the same rule as the n-threshold suppression elsewhere in this file.
  if (!tested || !Number.isFinite(achieved)) {
    return (
      <div className={cn('grid gap-1', RAMP)}>
        <span className={cn('truncate text-sm', hero && 'text-muted-foreground')}>{label}</span>
        {hero && <p className="font-display text-6xl leading-none tracking-tight">—</p>}
        <div className="h-2 w-full bg-border" />
        <p className="font-mono text-[0.6875rem] text-muted-foreground">
          no recall tests yet
        </p>
      </div>
    )
  }

  const short = achieved < target - 0.02
  const delta = achieved - target
  return (
    <div className={cn('grid gap-1', RAMP)}>
      <div className="flex items-baseline justify-between gap-3">
        <span className={cn('truncate text-sm', hero && 'text-muted-foreground')}>{label}</span>
        <span
          className={cn(
            'font-mono text-xs tabular-nums',
            short ? 'text-eosin' : 'text-muted-foreground',
          )}
        >
          {short ? '▼' : '▲'} {pct(Math.abs(delta))} vs target
        </span>
      </div>

      {hero && (
        // UI.md scopes Bodoni to the wordmark and "the dashboard's hero
        // numerals", which is this one. It overrides dataviz's sans-only rule
        // for hero figures: the house type system is the parameter, the method
        // is not.
        <p className="font-display text-6xl leading-none tracking-tight">{pct(achieved)}</p>
      )}

      <div
        className="relative h-2 w-full bg-[var(--h1)]"
        title={`${label}: ${pct(achieved)} of ${plural(tested, 'recall test')} passed, target ${pct(target)}`}
      >
        <div
          className={cn('h-full', short ? 'bg-eosin' : 'bg-[var(--h4)]')}
          style={{ width: `${Math.min(100, achieved * 100)}%` }}
        />
        {/* The promise, drawn on top of the measurement. */}
        <div
          className="absolute inset-y-[-3px] w-0.5 bg-foreground"
          style={{ left: `calc(${Math.min(100, target * 100)}% - 1px)` }}
        />
      </div>

      {!hero && (
        <p className="font-mono text-[0.6875rem] text-muted-foreground tabular-nums">
          {pct(achieved)} of {plural(tested, 'test')} · target {pct(target)}
        </p>
      )}
    </div>
  )
}

// ── forecast load ─────────────────────────────────────────────────────────

const H = 120

/** Columns, one per day. The wall you can see coming. */
export function Forecast({ days }: { days: ForecastDay[] }) {
  const max = Math.max(1, ...days.map((d) => d.due))
  const total = days.reduce((s, d) => s + d.due, 0)
  const peak = days.reduce((a, b) => (b.due > a.due ? b : a), days[0]!)
  // ≤24px thick, and the 2px gap is the surface doing the separating.
  const w = Math.min(24, Math.floor(640 / days.length) - 2)
  const pitch = w + 2
  const dayName = (d: number) =>
    d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`

  return (
    <Figure
      title="Forecast"
      hint={`${plural(total, 'review')} due over the next ${days.length} days · peak ${peak.due} ${dayName(peak.day)}`}
    >
      <svg
        viewBox={`0 0 ${days.length * pitch} ${H + 18}`}
        className="w-full"
        role="img"
        aria-label={`Reviews due per day for the next ${days.length} days, peaking at ${peak.due} ${dayName(peak.day)}.`}
      >
        <clipPath id="forecast-baseline">
          <rect x="0" y="0" width={days.length * pitch} height={H} />
        </clipPath>
        <line x1="0" y1={H} x2={days.length * pitch} y2={H} className="stroke-border" strokeWidth="1" />
        <g clipPath="url(#forecast-baseline)">
          {days.map((d) => {
            const h = (d.due / max) * (H - 18)
            if (!d.due) return null
            return (
              <rect
                key={d.day}
                x={d.day * pitch}
                y={H - Math.max(h, 2)}
                width={w}
                height={Math.max(h, 2) + 4}
                rx="4"
                className="fill-[var(--h4)]"
                data-label={`${plural(d.due, 'card')} ${dayName(d.day)}`}
              />
            )
          })}
        </g>
        {/* Label the extreme only — a number on every column goes unread. */}
        <text
          x={Math.min(peak.day * pitch, (days.length - 3) * pitch)}
          y={H - (peak.due / max) * (H - 18) - 4}
          className="fill-foreground font-mono text-[9px]"
        >
          {peak.due}
        </text>
        {[0, 7, 14, 21].filter((d) => d < days.length).map((d) => (
          <text key={d} x={d * pitch} y={H + 14} className="fill-muted-foreground font-mono text-[9px]">
            {d === 0 ? 'today' : `+${d}d`}
          </text>
        ))}
      </svg>
    </Figure>
  )
}

// ── time of day ───────────────────────────────────────────────────────────

/**
 * Accuracy by hour, as a deviation from your *own* average.
 *
 * Plotting raw accuracy from a zero baseline would squeeze every interesting
 * value into the top sixth of the chart. Against your own mean it becomes a
 * diverging form — two hues and a neutral midpoint, per dataviz — and the
 * question it answers is the useful one: which hours are you worse at than you
 * usually are. Hours with too little history are drawn on the track colour and
 * make no claim, because a 0% pass rate over two cards is not an insight.
 */
export function TimeOfDay({ hours, minReviews = 20 }: { hours: HourRow[]; minReviews?: number }) {
  const total = hours.reduce((s, h) => s + h.reviews, 0)
  const mean = total ? hours.reduce((s, h) => s + h.passed, 0) / total : 0
  const real = hours.filter((h) => h.reviews >= minReviews)
  const dev = (h: HourRow) => h.passed / h.reviews - mean
  const span = Math.max(0.05, ...real.map((h) => Math.abs(dev(h))))
  const worst = real.length ? real.reduce((a, b) => (dev(b) < dev(a) ? b : a)) : null

  const half = 52
  const w = 22
  const pitch = 24
  const clock = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? 'am' : 'pm'}`

  return (
    <Figure
      title="Time of day"
      hint={
        worst
          ? `You are ${pct(Math.abs(dev(worst)))} below your own average at ${clock(worst.hour)} — average ${pct(mean)}`
          : 'Not enough history yet to compare hours'
      }
    >
      <svg
        viewBox={`0 0 ${24 * pitch} ${half * 2 + 16}`}
        className="w-full"
        role="img"
        aria-label={`Recall accuracy by hour of day against a ${pct(mean)} average.`}
      >
        {hours.map((h) => {
          const enough = h.reviews >= minReviews
          const d = enough ? dev(h) : 0
          const len = enough ? Math.max(2, (Math.abs(d) / span) * (half - 6)) : 2
          return (
            <rect
              key={h.hour}
              x={h.hour * pitch + 1}
              y={d >= 0 ? half - len : half}
              width={w}
              height={len}
              rx="4"
              className={!enough ? 'fill-border' : d >= 0 ? 'fill-[var(--h4)]' : 'fill-eosin'}
              data-label={
                enough
                  ? `${clock(h.hour)}: ${pct(h.passed / h.reviews)} correct over ${plural(h.reviews, 'review')} (${d >= 0 ? '+' : ''}${pct(d)})`
                  : `${clock(h.hour)}: only ${plural(h.reviews, 'review')} — too few to judge`
              }
            />
          )
        })}
        {/* Last, so it covers the rounded corner at each bar's zero end. It is
            a reference line, not a gridline: "above" and "below" are the whole
            reading, so it carries more weight than the recessive default. */}
        <line x1="0" y1={half} x2={24 * pitch} y2={half} className="stroke-muted-foreground" strokeWidth="1" />
        {[0, 6, 12, 18].map((h) => (
          <text
            key={h}
            x={h * pitch + 1}
            y={half * 2 + 12}
            className="fill-muted-foreground font-mono text-[9px]"
          >
            {clock(h)}
          </text>
        ))}
      </svg>
      <p className="mt-1 flex gap-4 font-mono text-[0.6875rem] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2 bg-[var(--h4)]" /> above your average
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2 bg-eosin" /> below
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2 bg-border" /> too few reviews
        </span>
      </p>
    </Figure>
  )
}

// ── heatmap and streak ────────────────────────────────────────────────────

const CELL = 11
const PITCH = CELL + 2 // the 2px surface gap, same width everywhere

/**
 * A year of reviews. Five ordinal steps of one hue, plus the track for a day
 * with nothing on it — an empty day is not "step zero", it is absence.
 *
 * Steps are cut against the 90th percentile of *active* days rather than the
 * maximum: one 900-card catch-up after a holiday would otherwise flatten every
 * ordinary day to the lightest step and the chart would say nothing.
 */
export function Heatmap({
  days, streak, title = 'A year of reviews',
}: { days: DayCount[]; streak: number; title?: string }) {
  const active = days.filter((d) => d.reviews > 0).map((d) => d.reviews).sort((a, b) => a - b)
  const cap = active.length ? active[Math.floor(active.length * 0.9)]! : 1
  const step = (n: number) => (n === 0 ? 0 : Math.max(1, Math.min(5, Math.ceil((n / cap) * 5))))
  const total = days.reduce((s, d) => s + d.reviews, 0)

  const lead = new Date(days[0]!.date).getDay()
  const cols = Math.ceil((lead + days.length) / 7)
  const fmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
  const month = new Intl.DateTimeFormat(undefined, { month: 'short' })

  return (
    <Figure
      title={title}
      hint={`${plural(total, 'review')} on ${plural(active.length, 'day')} · ${plural(streak, 'day')} streak`}
    >
      <svg
        viewBox={`0 0 ${cols * PITCH} ${7 * PITCH + 14}`}
        className="w-full"
        role="img"
        aria-label={`Review heatmap: ${total} reviews across ${active.length} days, current streak ${streak} days.`}
      >
        {days.map((d, i) => {
          const cell = lead + i
          const s = step(d.reviews)
          return (
            <rect
              key={d.date}
              x={Math.floor(cell / 7) * PITCH}
              y={(cell % 7) * PITCH}
              width={CELL}
              height={CELL}
              rx="1"
              // Inline, not a utility class: Tailwind only emits the classes it
              // can find as literal text, and `fill-[var(--h${s})]` is not one.
              className={s === 0 ? 'fill-border' : undefined}
              style={s === 0 ? undefined : { fill: `var(--h${s})` }}
              data-label={`${fmt.format(d.date)}: ${d.reviews ? `${plural(d.reviews, 'review')}, ${pct(d.passed / d.reviews)} correct` : 'nothing studied'}`}
            />
          )
        })}
        {days.map((d, i) => {
          const date = new Date(d.date)
          if (date.getDate() > 7 || (lead + i) % 7 !== 0) return null
          return (
            <text
              key={`m${d.date}`}
              x={Math.floor((lead + i) / 7) * PITCH}
              y={7 * PITCH + 10}
              className="fill-muted-foreground font-mono text-[9px]"
            >
              {month.format(date)}
            </text>
          )
        })}
      </svg>
      {/* An ordinal ramp *is* the value, so it needs its key. */}
      <p className="mt-1 flex items-center justify-end gap-1 font-mono text-[0.6875rem] text-muted-foreground">
        less
        <span className="inline-block size-2 bg-border" />
        {[1, 2, 3, 4, 5].map((s) => (
          <span key={s} className="inline-block size-2" style={{ background: `var(--h${s})` }} />
        ))}
        more
      </p>
    </Figure>
  )
}

/**
 * The one tile that is a number and not a chart.
 *
 * `note` is not decoration and is close to required in practice: a number with
 * nothing beside it is trivia, because the reader has no way to know whether
 * 340 is good. The comparison, the denominator or the unit is what makes it a
 * statistic.
 *
 * `help` is the sentence explaining where the figure came from. Several of
 * these are model output rather than measurement — burden, daily cost, anything
 * derived from stability — and a dashboard that does not say so is laundering a
 * prediction as a fact. Delivered as a `title`, which costs nothing, works on
 * keyboard focus, and cannot collide with a viewport edge the way a floating
 * tooltip does.
 *
 * ponytail: `title` is invisible on touch. A real popover is the upgrade if
 * anyone asks; the sentences are already written and would move as they are.
 */
export function Tile({
  label, value, note, help, icon: Icon,
}: {
  label: string
  value: string
  note?: string
  help?: string
  icon?: ComponentType<{ className?: string }>
}) {
  return (
    <div className="border-t border-border pt-3" title={help}>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {Icon && <Icon className="size-3.5" />}
        {label}
        {help && <span className="sr-only">. {help}</span>}
      </p>
      <p className="text-2xl leading-tight font-semibold tabular-nums">{value}</p>
      {note && <p className="font-mono text-[0.6875rem] text-muted-foreground">{note}</p>}
    </div>
  )
}

// ── time, composition and workload (PLAN §7) ──────────────────────────────

/** Minutes, said the way a person would say them. */
export function duration(ms: number): string {
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  return mins % 60 ? `${hours}h ${mins % 60}m` : `${hours}h`
}

/**
 * The same calendar as the review heatmap, measuring time instead of count.
 *
 * Worth its own chart rather than a toggle on the other one: "I studied every
 * day" and "I studied for four hours" are different claims, and a fortnight of
 * five-minute days looks identical to a fortnight of real work when you only
 * count cards. Side by side, the difference between them is the finding.
 */
export function TimeHeatmap({ days }: { days: { date: number; ms: number; reviews: number }[] }) {
  const active = days.filter((d) => d.ms > 0).map((d) => d.ms).sort((a, b) => a - b)
  const cap = active.length ? active[Math.floor(active.length * 0.9)]! : 1
  const step = (ms: number) => (ms === 0 ? 0 : Math.max(1, Math.min(5, Math.ceil((ms / cap) * 5))))
  const total = days.reduce((s, d) => s + d.ms, 0)

  const lead = new Date(days[0]!.date).getDay()
  const cols = Math.ceil((lead + days.length) / 7)
  const fmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
  const month = new Intl.DateTimeFormat(undefined, { month: 'short' })

  return (
    <Figure
      title="A year of minutes"
      hint={`${duration(total)} across ${plural(active.length, 'day')} · typical day ${duration(cap)}`}
    >
      <svg
        viewBox={`0 0 ${cols * PITCH} ${7 * PITCH + 14}`}
        className="w-full"
        role="img"
        aria-label={`Study-time heatmap: ${duration(total)} across ${active.length} days.`}
      >
        {days.map((d, i) => {
          const cell = lead + i
          const s = step(d.ms)
          return (
            <rect
              key={d.date}
              x={Math.floor(cell / 7) * PITCH}
              y={(cell % 7) * PITCH}
              width={CELL}
              height={CELL}
              rx="1"
              className={s === 0 ? 'fill-border' : undefined}
              style={s === 0 ? undefined : { fill: `var(--h${s})` }}
              data-label={
                d.ms
                  ? `${fmt.format(d.date)}: ${duration(d.ms)} over ${plural(d.reviews, 'card')}`
                  : `${fmt.format(d.date)}: nothing studied`
              }
            />
          )
        })}
        {days.map((d, i) => {
          const date = new Date(d.date)
          if (date.getDate() > 7 || (lead + i) % 7 !== 0) return null
          return (
            <text
              key={`m${d.date}`}
              x={Math.floor((lead + i) / 7) * PITCH}
              y={7 * PITCH + 10}
              className="fill-muted-foreground font-mono text-[9px]"
            >
              {month.format(date)}
            </text>
          )
        })}
      </svg>
      <p className="mt-1 flex items-center justify-end gap-1 font-mono text-[0.6875rem] text-muted-foreground">
        less
        <span className="inline-block size-2 bg-border" />
        {[1, 2, 3, 4, 5].map((s) => (
          <span key={s} className="inline-block size-2" style={{ background: `var(--h${s})` }} />
        ))}
        more
      </p>
    </Figure>
  )
}

/**
 * Parts of a whole, as one bar.
 *
 * Not a pie. Card states are *ordinal* — new, learning, young, mature are
 * stages of one pipeline — so the sequential ramp is the semantically right
 * encoding and the order of the segments is fixed by meaning rather than by
 * size. A bar also stacks: one row per deck would compare decks for free, which
 * a row of pie charts categorically cannot do.
 *
 * Every segment is direct-labelled, because the interior of a stacked bar is
 * read against a moving baseline and the labels are what make it legible.
 */
export function Composition({
  title, hint, parts,
}: {
  title: string
  hint: string
  parts: { label: string; value: number; step: number }[]
}) {
  const sum = parts.reduce((s, p) => s + p.value, 0)
  const total = sum || 1
  const shown = parts.filter((p) => p.value > 0)

  if (!sum) {
    return (
      <Figure title={title} hint="nothing in this window">
        <p className="text-xs text-muted-foreground">Nothing recorded yet.</p>
      </Figure>
    )
  }

  return (
    <Figure title={title} hint={hint}>
      <div className="flex h-7 w-full overflow-hidden rounded-sm" role="img"
           aria-label={shown.map((p) => `${p.label} ${p.value}`).join(', ')}>
        {shown.map((p) => (
          <span
            key={p.label}
            className="h-full"
            style={{ width: `${(p.value / total) * 100}%`, background: `var(--h${p.step})` }}
            data-label={`${p.label}: ${p.value.toLocaleString()} (${pct(p.value / total)})`}
          />
        ))}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
        {parts.map((p) => (
          <div key={p.label} className="flex items-center gap-2">
            <span className="size-2 shrink-0 rounded-[1px]" style={{ background: `var(--h${p.step})` }} />
            <dt className="flex-1 truncate text-muted-foreground">{p.label}</dt>
            <dd className="font-mono tabular-nums">{p.value.toLocaleString()}</dd>
          </div>
        ))}
      </dl>
    </Figure>
  )
}

/**
 * A ranked list of magnitudes — minutes per deck, most often.
 *
 * Horizontal because the labels are deck names and deck names are words;
 * zero-based because it is a length encoding and a truncated bar is the classic
 * lie. Sorted, so "where is my time going" is one sweep of the eye.
 */
export function RankedBars({
  title, hint, rows, format,
}: {
  title: string
  hint: string
  rows: { label: string; value: number; note?: string }[]
  format: (value: number) => string
}) {
  const max = Math.max(1, ...rows.map((r) => r.value))

  return (
    <Figure title={title} hint={hint}>
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li key={r.label} className="grid grid-cols-[8rem_1fr_auto] items-center gap-3 text-xs">
            <span className="truncate text-muted-foreground" title={r.label}>{r.label}</span>
            <span className="h-3 w-full rounded-[2px] bg-border/60">
              <span
                className="block h-full rounded-[2px]"
                style={{ width: `${(r.value / max) * 100}%`, background: 'var(--h4)' }}
                data-label={`${r.label}: ${format(r.value)}${r.note ? ` · ${r.note}` : ''}`}
              />
            </span>
            <span className="font-mono tabular-nums">{format(r.value)}</span>
          </li>
        ))}
        {!rows.length && <li className="text-xs text-muted-foreground">Nothing in this window.</li>}
      </ul>
    </Figure>
  )
}

/**
 * How long a card takes.
 *
 * A histogram and three percentiles in words. Deliberately *not* a box plot:
 * the misreadings are documented and common even among people who read charts
 * for a living — whiskers taken for the full range, the box taken for
 * frequency — and a median with a p90 beside it says the same thing in a
 * sentence anybody can read.
 */
export function AnswerTimeHistogram({
  buckets, median, p90, total,
}: {
  buckets: { upTo: number; n: number }[]
  median: number
  p90: number
  total: number
}) {
  const max = Math.max(1, ...buckets.map((b) => b.n))

  return (
    <Figure
      title="How long a card takes"
      hint={
        total
          ? `median ${(median / 1000).toFixed(1)}s · 90% under ${(p90 / 1000).toFixed(1)}s · ${plural(total, 'card')}`
          : 'nothing answered in this window'
      }
    >
      <div className="flex h-24 items-end gap-1" role="img"
           aria-label={`Answer times: median ${(median / 1000).toFixed(1)} seconds, 90% under ${(p90 / 1000).toFixed(1)} seconds.`}>
        {buckets.map((b, i) => (
          <span
            key={b.upTo}
            className="flex-1"
            style={{
              height: `${Math.max(b.n ? 3 : 0, (b.n / max) * 100)}%`,
              background: `var(--h${Math.min(5, 2 + Math.floor(i / 3))})`,
              // The last bucket is everything past the axis, so it is set apart
              // rather than quietly absorbing the tail.
              marginLeft: i === buckets.length - 1 ? '0.5rem' : undefined,
            }}
            data-label={`${i === buckets.length - 1 ? `over ${buckets[i - 1]!.upTo}s` : `up to ${b.upTo}s`}: ${plural(b.n, 'card')}`}
          />
        ))}
      </div>
      <div className="mt-1 flex gap-1 font-mono text-[9px] text-muted-foreground">
        {buckets.map((b, i) => (
          <span key={b.upTo} className="flex-1 text-center" style={{ marginLeft: i === buckets.length - 1 ? '0.5rem' : undefined }}>
            {i === buckets.length - 1 ? `${buckets[i - 1]!.upTo}s+` : b.upTo}
          </span>
        ))}
      </div>
    </Figure>
  )
}

// ── calibration: the caveat that licenses every other number here ──────────

/**
 * What the scheduler predicted against what actually happened.
 *
 * Every model-derived figure on this screen — burden, "days until 80%", the
 * memorised curve below — is exactly as true as FSRS's fit for this person.
 * Nothing said whether that fit was any good, so this does. It is only possible
 * because `reviews` is append-only and the scheduler is a pure fold: stopping
 * the fold before each past answer reconstructs what the model believed at that
 * moment. Anki does not store historical retrievability and cites that as the
 * blocker on its own automated-leech thread.
 *
 * A dot plot with the diagonal drawn, not a bar chart. Position against a
 * reference line is the whole message — **a point below the line is a promise
 * that was not kept** — and the axis zooms to the range that has data, which a
 * bar chart could not honestly do (truncating a bar axis is the classic
 * lie-by-length; position carries no zero-baseline obligation).
 *
 * Area scales with the square root of the bin's count, so a bin holding nine
 * reviews cannot shout as loudly as one holding nine thousand. Bins under
 * `minReviews` are drawn hollow and make no claim, which is the same
 * suppression rule `TimeOfDay` uses.
 */
export function Calibration({
  bins, error, minReviews = 30,
}: {
  bins: CalibrationBin[]
  error: { bias: number; rmse: number; n: number }
  minReviews?: number
}) {
  const SIZE = 168
  const PAD = 30

  // Zoomed to the data, floored so the diagonal always has room to read as a
  // diagonal. Predictions cluster at the top; a full 0–1 square would spend
  // four fifths of itself on a range nobody's cards live in.
  const lo = Math.min(0.5, ...bins.map((b) => b.from), ...bins.map((b) => b.observed))
  const hi = 1
  const at = (v: number) => PAD + ((v - lo) / (hi - lo)) * SIZE
  const y = (v: number) => PAD + SIZE - ((v - lo) / (hi - lo)) * SIZE
  const maxN = Math.max(1, ...bins.map((b) => b.n))

  const off = Math.abs(error.bias) * 100
  const verdict = error.n === 0
    ? 'not enough answered to say yet'
    : off < 1.5
      ? `the scheduler is calling it right, over ${plural(error.n, 'answer')}`
      : `running ${off.toFixed(1)}pp ${error.bias > 0 ? 'optimistic' : 'pessimistic'} over ${plural(error.n, 'answer')}`

  return (
    <Figure title="Is the scheduler right about you?" hint={verdict}>
      <svg
        viewBox={`0 0 ${SIZE + PAD * 2} ${SIZE + PAD * 2}`}
        className="mx-auto w-full max-w-[22rem]"
        role="img"
        aria-label={`Predicted recall against observed recall. The scheduler is ${verdict}.`}
      >
        {/* The promise. Everything on it was predicted correctly. */}
        <line
          x1={at(lo)} y1={y(lo)} x2={at(hi)} y2={y(hi)}
          className="stroke-border" strokeWidth="1" strokeDasharray="3 3"
        />
        <line x1={PAD} y1={PAD + SIZE} x2={PAD + SIZE} y2={PAD + SIZE} className="stroke-border" strokeWidth="1" />
        <line x1={PAD} y1={PAD} x2={PAD} y2={PAD + SIZE} className="stroke-border" strokeWidth="1" />

        {bins.map((b) => {
          const thin = b.n < minReviews
          return (
            <circle
              key={b.from}
              cx={at(b.predicted)}
              cy={y(b.observed)}
              r={3 + Math.sqrt(b.n / maxN) * 6}
              className={thin ? 'fill-none stroke-[var(--h3)]' : 'fill-[var(--h4)]'}
              strokeWidth="1.5"
              data-label={
                `predicted ${pct(b.predicted)}, recalled ${pct(b.observed)} · ${plural(b.n, 'answer')}`
                + (thin ? ' (too few to claim)' : '')
              }
            />
          )
        })}

        {[lo, (lo + 1) / 2, 1].map((v) => (
          <text key={`x${v}`} x={at(v)} y={PAD + SIZE + 14} textAnchor="middle"
                className="fill-muted-foreground font-mono text-[9px]">
            {pct(v)}
          </text>
        ))}
        {[lo, (lo + 1) / 2, 1].map((v) => (
          <text key={`y${v}`} x={PAD - 6} y={y(v) + 3} textAnchor="end"
                className="fill-muted-foreground font-mono text-[9px]">
            {pct(v)}
          </text>
        ))}
        <text x={PAD + SIZE / 2} y={SIZE + PAD * 2 - 4} textAnchor="middle"
              className="fill-muted-foreground font-sans text-[9px]">
          predicted
        </text>
        <text x={10} y={PAD + SIZE / 2} textAnchor="middle"
              transform={`rotate(-90 10 ${PAD + SIZE / 2})`}
              className="fill-muted-foreground font-sans text-[9px]">
          actually recalled
        </text>
      </svg>

      <p className="mx-auto mt-2 max-w-prose text-xs text-muted-foreground">
        {error.n === 0
          ? 'A card has to be answered at least once after a real gap before its prediction can be scored.'
          : error.bias > 0
            ? 'Points below the dashed line are answers the scheduler expected you to get and you did not — intervals running long. The figure is weighted by how many answers fell in each bin.'
            : 'Points above the dashed line are cards you held better than predicted — intervals running short, which costs time rather than memory.'}
      </p>
    </Figure>
  )
}

// ── memorised over time ────────────────────────────────────────────────────

/**
 * How much the collection holds, day by day.
 *
 * The same replay as `Calibration`, read the other way: a card's stability on
 * each past day, run back through the forgetting curve and summed. Anki ships
 * the scalar — "you remember N cards" — and the time series is one of the most
 * requested graphs on its forums, because the scalar cannot tell growth from a
 * plateau from a slide.
 *
 * It is a *model output*, not a measurement, which is why it is drawn directly
 * under the calibration chart and never above it. If the scheduler is running
 * optimistic, this line is too, by about the same amount.
 */
export function Memorised({ days }: { days: MemorisedDay[] }) {
  const W = 640
  const H = 120
  const max = Math.max(1, ...days.map((d) => d.remembered))
  const last = days.at(-1)
  const firstNonZero = days.find((d) => d.remembered > 0)
  const gained = last && firstNonZero ? last.remembered - firstNonZero.remembered : 0

  const x = (i: number) => (i / Math.max(1, days.length - 1)) * W
  const y = (v: number) => H - (v / max) * (H - 10)

  const line = days.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(d.remembered).toFixed(1)}`).join(' ')

  return (
    <Figure
      title="Cards you can still recall"
      hint={
        last
          ? `${Math.round(last.remembered).toLocaleString()} of ${plural(last.cards, 'card')} studied`
            + (gained ? ` · ${gained > 0 ? '+' : ''}${Math.round(gained).toLocaleString()} over ${days.length} days` : '')
          : 'nothing studied yet'
      }
    >
      <svg viewBox={`0 0 ${W} ${H + 16}`} className="w-full" role="img"
           aria-label={`Recallable cards over the last ${days.length} days, now about ${Math.round(last?.remembered ?? 0)}.`}>
        <line x1="0" y1={H} x2={W} y2={H} className="stroke-border" strokeWidth="1" />
        <path d={`${line} L${W} ${H} L0 ${H} Z`} className="fill-[var(--h1)] opacity-40" />
        <path d={line} className="fill-none stroke-[var(--h5)]" strokeWidth="1.5" />

        {/* One hover target per day, invisible, so the readout works without
            365 marks or a tooltip layer. */}
        {days.map((d, i) => (
          <rect
            key={d.date}
            x={x(i) - W / days.length / 2} y="0"
            width={W / days.length} height={H}
            className="fill-transparent"
            data-label={`${new Date(d.date).toLocaleDateString()}: about ${Math.round(d.remembered).toLocaleString()} recallable`}
          />
        ))}

        {[0, Math.floor(days.length / 2), days.length - 1].map((i) => (
          <text key={i} x={Math.min(Math.max(x(i), 12), W - 12)} y={H + 12} textAnchor="middle"
                className="fill-muted-foreground font-mono text-[9px]">
            {i === days.length - 1 ? 'today' : `−${days.length - 1 - i}d`}
          </text>
        ))}
      </svg>

      <p className="mt-2 max-w-prose text-xs text-muted-foreground">
        The sum of the model's recall probability across every card you have studied —
        not a count of cards. It is a model output, so read it against the calibration
        above: an optimistic scheduler draws an optimistic line.
      </p>
    </Figure>
  )
}

// ── this week, for the front door ─────────────────────────────────────────

/**
 * The week so far, as seven cells.
 *
 * The year heatmap answers "have I kept this up", which is a question for the
 * dashboard. On the way in, the question is smaller and more useful: *did I
 * study today, and how is this week going.* Seven cells answer it without the
 * page becoming a chart.
 *
 * A calendar week, Monday to Sunday, rather than a trailing seven days — days
 * that have not happened yet are drawn as empty outlines, which is the part a
 * trailing window cannot show and the part that makes it read as a week with
 * something left in it rather than a score.
 */
export function WeekActivity({ days, streak }: { days: DayCount[]; streak: number }) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  // Monday start: `getDay()` is 0 for Sunday, which would otherwise begin the
  // week on the day most people think of as ending it.
  const monday = new Date(today)
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7))

  const byDate = new Map(days.map((d) => {
    const at = new Date(d.date)
    at.setHours(0, 0, 0, 0)
    return [at.getTime(), d.reviews]
  }))

  const week = Array.from({ length: 7 }, (_, i) => {
    const at = new Date(monday)
    at.setDate(monday.getDate() + i)
    const date = at.getTime()
    return {
      date,
      reviews: byDate.get(date) ?? 0,
      isToday: date === today.getTime(),
      future: date > today.getTime(),
    }
  })

  const done = week.reduce((s, d) => s + d.reviews, 0)
  const busiest = Math.max(1, ...week.map((d) => d.reviews))
  const initial = new Intl.DateTimeFormat(undefined, { weekday: 'narrow' })
  const full = new Intl.DateTimeFormat(undefined, { weekday: 'long' })

  return (
    <div className={cn('flex items-center gap-4', RAMP)}>
      <div className="flex gap-1.5" role="img"
           aria-label={`This week: ${plural(done, 'review')}, ${plural(streak, 'day')} streak.`}>
        {week.map((d) => (
          <div key={d.date} className="flex flex-col items-center gap-1">
            <span
              title={`${full.format(d.date)}: ${d.future ? 'still to come' : plural(d.reviews, 'review')}`}
              className={cn(
                'size-7 rounded-sm transition-colors',
                d.future
                  ? 'border border-dashed border-border'
                  : d.reviews === 0
                    ? 'bg-border/60'
                    : '',
                d.isToday && 'ring-1 ring-hematoxylin ring-offset-1 ring-offset-background',
              )}
              style={d.future || !d.reviews ? undefined : {
                background: `var(--h${Math.max(1, Math.min(5, Math.ceil((d.reviews / busiest) * 5)))})`,
              }}
            />
            <span className="font-mono text-[0.5625rem] text-muted-foreground">
              {initial.format(d.date)}
            </span>
          </div>
        ))}
      </div>

      <div className="min-w-0">
        <p className="font-mono text-xs text-muted-foreground">
          {done ? `${done.toLocaleString()} this week` : 'nothing yet this week'}
        </p>
        {streak > 0 && (
          <p className="flex items-center gap-1 font-mono text-xs text-hematoxylin">
            <Flame className="size-3" /> {plural(streak, 'day')}
          </p>
        )}
      </div>
    </div>
  )
}
