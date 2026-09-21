import { useMemo, useState } from 'react'
import { ArrowRight, Play } from 'lucide-react'
import { runSimCard, type SimResult, type SimRun } from '@recall/core'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/**
 * A simulation card: predict, then watch it run.
 *
 * **This is the one card in the product that is not HTML**, and the reason is
 * README rule 5 rather than preference. Card content renders in a script-less
 * iframe *because it is untrusted* — it may have arrived from an imported Anki
 * deck, a cloned marketplace listing or a language model. A chart you can read
 * against your own prediction needs to be live, so it cannot go in there.
 *
 * What makes that safe is that **nothing here comes from the note except
 * numbers**. The note names a model and supplies parameter values; the model is
 * ours, the chart is ours, and an unrecognised name runs nothing at all. There
 * is no path by which a card can execute anything.
 *
 * The prediction is asked for *before* the answer is shown and kept visible
 * afterwards, which is the entire pedagogical point: committing to a number and
 * being wrong is what makes the correction stick. A card that just showed the
 * curve would be a diagram with a scheduler attached.
 */
export function SimCard({ fields, revealed }: { fields: Record<string, string>; revealed: boolean }) {
  const [prediction, setPrediction] = useState('')
  const [committed, setCommitted] = useState<number | null>(null)

  const run = useMemo(() => build(fields), [fields])

  if (!run) {
    return (
      <p className="mt-4 border-t border-border pt-4 text-sm text-eosin">
        This card names a simulation that does not exist here. It may have come from a
        newer version of the app.
      </p>
    )
  }

  const { model, answer } = run
  const output = model.outputs.find((o) => o.key === targetOf(fields)) ?? model.outputs[0]!
  const actual = answer.after ?? answer.before
  const guess = committed
  const error = guess === null ? null : Math.abs(guess - actual) / (Math.abs(actual) || 1)

  return (
    <div className="mt-4 space-y-4 border-t border-border pt-4">
      {!revealed ? (
        <div className="space-y-2">
          <label htmlFor="sim-prediction" className="text-xs text-muted-foreground">
            Your prediction — {output.label} {output.unit && `(${output.unit})`}
          </label>
          <div className="flex gap-2">
            <Input
              id="sim-prediction"
              inputMode="decimal"
              className="w-40 font-mono"
              placeholder="a number"
              value={prediction}
              onChange={(e) => setPrediction(e.target.value)}
              onBlur={() => setCommitted(parse(prediction))}
            />
            <Button variant="outline" size="sm" onClick={() => setCommitted(parse(prediction))}>
              <Play /> Commit
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Optional, and worth doing. Being wrong on purpose is what makes the answer
            stick.
          </p>
        </div>
      ) : (
        <>
          <dl className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
            {answer.after !== undefined && (
              <Figure label="Before" value={fmt(answer.before, output.precision)} unit={output.unit} />
            )}
            <Figure
              label={answer.after !== undefined ? 'After' : output.label}
              value={fmt(actual, output.precision)}
              unit={output.unit}
              hero
            />
            {answer.ratio !== undefined && (
              <Figure label="Change" value={`${((answer.ratio - 1) * 100).toFixed(0)}%`} unit="" />
            )}
            {guess !== null && (
              <Figure
                label="You said"
                value={fmt(guess, output.precision)}
                unit={output.unit}
                tone={error !== null && error <= 0.1 ? 'good' : 'off'}
              />
            )}
          </dl>

          {guess !== null && error !== null && (
            <p className="text-sm text-muted-foreground">
              {error <= 0.1
                ? 'Within ten per cent — you have the relationship, not just the direction.'
                : `Out by ${(error * 100).toFixed(0)}%. The direction is the easy half; the size is the lesson.`}
            </p>
          )}

          <Chart run={run} />
        </>
      )}
    </div>
  )
}

const Figure = ({
  label, value, unit, hero, tone,
}: {
  label: string
  value: string
  unit: string
  hero?: boolean
  tone?: 'good' | 'off'
}) => (
  <div>
    <dt className="text-xs text-muted-foreground">{label}</dt>
    <dd
      className={cn(
        'font-mono tabular-nums',
        hero ? 'text-2xl' : 'text-lg',
        tone === 'good' && 'text-hematoxylin',
        tone === 'off' && 'text-eosin',
      )}
    >
      {value}
      {unit && <span className="ml-1 text-xs text-muted-foreground">{unit}</span>}
    </dd>
  </div>
)

/**
 * The curve, drawn as inline SVG like every other chart in this app.
 *
 * Both traces share one scale, because the comparison *is* the answer — two
 * charts side by side with their own axes would let a 30% fall and a 70% fall
 * look identical, which is precisely the mistake the card is correcting.
 */
function Chart({ run }: { run: SimRun }) {
  const traces = [
    { result: run.baseline, faint: run.changed !== undefined },
    ...(run.changed ? [{ result: run.changed, faint: false }] : []),
  ]

  const key = Object.keys(run.baseline.series?.values ?? {})[0]
  if (!key || !run.baseline.series) return null

  // The y axis is whichever output the traced series is. Naming it matters
  // more here than on most charts: a pressure–volume loop and a pressure trace
  // are the same rectangle-ish shape to anybody who has not met one before.
  const yAxis = run.model.outputs.find((o) => o.key === key)
    ?? run.model.outputs.find((o) => key.startsWith(o.key))

  const all = traces.flatMap((t) => t.result.series?.values[key] ?? [])
  const xs = traces.flatMap((t) => t.result.series?.t ?? [])
  const [lo, hi] = [Math.min(...all), Math.max(...all)]
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)]
  const pad = (hi - lo) * 0.08 || 1

  const path = (result: SimResult) => {
    const s = result.series
    if (!s) return ''
    return s.t
      .map((x, i) => {
        const vx = ((x - x0) / (x1 - x0 || 1)) * 100
        const vy = 100 - ((s.values[key]![i]! - (lo - pad)) / (hi - lo + 2 * pad)) * 100
        return `${i === 0 ? 'M' : 'L'}${vx.toFixed(2)} ${vy.toFixed(2)}`
      })
      .join(' ')
  }

  return (
    <figure className="space-y-1">
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="h-44 w-full"
        role="img"
        aria-label={`${run.model.name}: ${run.changed ? 'before and after the change' : 'the simulated curve'}`}
      >
        {traces.map((trace, i) => (
          <path
            key={i}
            d={path(trace.result)}
            fill="none"
            stroke={trace.faint ? 'var(--color-border)' : 'var(--color-hematoxylin)'}
            strokeWidth={trace.faint ? 1.2 : 1.6}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <figcaption className="flex justify-between font-mono text-[0.625rem] text-muted-foreground">
        <span>
          {cap(key)}
          {yAxis?.unit && ` (${yAxis.unit})`} vs {run.model.xLabel?.toLowerCase()} ({run.model.xUnit})
        </span>
        {run.changed && <span>faint: before · solid: after</span>}
      </figcaption>
    </figure>
  )
}

/**
 * Read a card's fields into something the model can run.
 *
 * Every parse is tolerant on purpose. These fields are hand-edited text in a
 * note that can be imported, synced or cloned, so malformed JSON has to mean
 * "no overrides" rather than a card that cannot be studied.
 */
function build(fields: Record<string, string>): SimRun | null {
  const model = text(fields.Model)
  if (!model) return null

  const change = json(fields.Change)
  const key = typeof change.key === 'string' ? change.key : undefined
  const to = Number(change.to)

  return runSimCard({
    model,
    params: numbers(json(fields.Parameters)),
    change: key && Number.isFinite(to) ? { key, to } : undefined,
    target: targetOf(fields),
  })
}

const targetOf = (fields: Record<string, string>) => text(fields.Target) || ''

const text = (value: string | undefined) =>
  (value ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').trim()

function json(value: string | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text(value) || '{}') as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** Only the numeric entries. Anything else is dropped rather than coerced. */
function numbers(source: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(source)) {
    const n = Number(v)
    if (Number.isFinite(n)) out[k] = n
  }
  return out
}

const parse = (raw: string): number | null => {
  const n = Number(raw.trim().replace(/[^0-9.\-+eE]/g, ''))
  return raw.trim() !== '' && Number.isFinite(n) ? n : null
}

const fmt = (value: number, precision: number) => value.toFixed(precision)

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
