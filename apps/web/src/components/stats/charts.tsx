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
import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import type { DayCount, ForecastDay, HourRow } from '@/db/queries/stats'

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
export function Heatmap({ days, streak }: { days: DayCount[]; streak: number }) {
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
      title="A year of reviews"
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

/** The one tile that is a number and not a chart. */
export function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="border-t border-border pt-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold leading-tight">{value}</p>
      {note && <p className="font-mono text-[0.6875rem] text-muted-foreground">{note}</p>}
    </div>
  )
}
