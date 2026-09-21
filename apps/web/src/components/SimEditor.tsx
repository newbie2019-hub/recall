import { useMemo } from 'react'
import { SIM_MODELS, runSimCard, simModel } from '@recall/core'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

/**
 * Authoring a simulation card without writing JSON.
 *
 * The note stores `Model`, `Parameters`, `Change` and `Target` as text, because
 * a note's fields are text — that is what syncs, what exports to Anki and what
 * a marketplace listing carries. But nobody should have to *type* that, and a
 * card whose JSON has a typo is a card that silently stops being a question.
 *
 * So this is the whole of the authoring experience: pick a model, set the
 * starting conditions, pick the one thing the question changes, pick what is
 * being predicted. The answer is computed live underneath, which is the check
 * that matters — a card asking about a change that turns out to move nothing is
 * a bad card, and the author should find that out here rather than in a review
 * six weeks later.
 */
export function SimEditor({
  fields, onChange,
}: {
  fields: Record<string, string>
  onChange: (next: Record<string, string>) => void
}) {
  const model = simModel(strip(fields.Model)) ?? null
  const params = useMemo(() => numbers(parse(fields.Parameters)), [fields.Parameters])
  const change = useMemo(() => parse(fields.Change), [fields.Change])

  const changeKey = typeof change.key === 'string' ? change.key : ''
  const changeTo = Number(change.to)

  const preview = model
    ? runSimCard({
      model: model.id,
      params,
      change: changeKey && Number.isFinite(changeTo) ? { key: changeKey, to: changeTo } : undefined,
      target: strip(fields.Target) || model.outputs[0]!.key,
    })
    : null

  const set = (patch: Record<string, string>) => onChange({ ...fields, ...patch })

  const setParam = (key: string, value: string) => {
    const next = { ...params }
    const n = Number(value)
    if (value.trim() === '') delete next[key]
    else if (Number.isFinite(n)) next[key] = n
    set({ Parameters: JSON.stringify(next) })
  }

  return (
    <div className="space-y-6 rounded-md border border-border p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="sim-model">Simulation</Label>
          <Select
            value={model?.id ?? ''}
            onValueChange={(id) => {
              // Parameters and target belong to the old model, so they go with
              // it. Keeping them would leave a card referring to a slider that
              // no longer exists.
              const next = simModel(id)
              set({
                Model: id,
                Parameters: '{}',
                Change: '{}',
                Target: next?.outputs[0]?.key ?? '',
              })
            }}
          >
            <SelectTrigger id="sim-model"><SelectValue placeholder="Choose a model" /></SelectTrigger>
            <SelectContent>
              {SIM_MODELS.map((m) => (
                <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {model && <p className="text-xs text-muted-foreground">Teaches: {model.teaches}</p>}
        </div>

        {model && (
          <div className="space-y-2">
            <Label htmlFor="sim-target">They predict</Label>
            <Select
              value={strip(fields.Target) || model.outputs[0]!.key}
              onValueChange={(target) => set({ Target: target })}
            >
              <SelectTrigger id="sim-target"><SelectValue /></SelectTrigger>
              <SelectContent>
                {model.outputs.map((o) => (
                  <SelectItem key={o.key} value={o.key}>
                    {o.label}{o.unit && ` (${o.unit})`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {model && (
        <>
          <div className="space-y-3 border-t border-border pt-4">
            <p className="text-xs tracking-[0.14em] text-muted-foreground uppercase">
              Starting conditions
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {model.parameters.map((p) => (
                <div key={p.key} className="space-y-1">
                  <Label htmlFor={`sim-${p.key}`} className="text-xs">
                    {p.label}
                    {p.unit && <span className="ml-1 text-muted-foreground">({p.unit})</span>}
                  </Label>
                  <Input
                    id={`sim-${p.key}`}
                    type="number"
                    min={p.min}
                    max={p.max}
                    step={p.step}
                    className="h-8 font-mono text-xs"
                    // Blank means "the model's own default", which is why an
                    // untouched field is empty rather than pre-filled: a card
                    // that stores every default cannot inherit a better one.
                    placeholder={String(p.default)}
                    value={params[p.key] ?? ''}
                    onChange={(e) => setParam(p.key, e.target.value)}
                  />
                  {p.hint && <p className="text-[0.6875rem] text-muted-foreground">{p.hint}</p>}
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-3 border-t border-border pt-4">
            <p className="text-xs tracking-[0.14em] text-muted-foreground uppercase">
              The question changes
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="sim-change" className="text-xs">Parameter</Label>
                <Select
                  value={changeKey || 'none'}
                  onValueChange={(key) =>
                    set({ Change: key === 'none' ? '{}' : JSON.stringify({ key, to: changeTo || 0 }) })}
                >
                  <SelectTrigger id="sim-change" className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Nothing — ask about one condition</SelectItem>
                    {model.parameters.map((p) => (
                      <SelectItem key={p.key} value={p.key}>{p.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {changeKey && (
                <div className="space-y-1">
                  <Label htmlFor="sim-change-to" className="text-xs">Changes to</Label>
                  <Input
                    id="sim-change-to"
                    type="number"
                    className="h-8 font-mono text-xs"
                    value={Number.isFinite(changeTo) ? changeTo : ''}
                    onChange={(e) =>
                      set({ Change: JSON.stringify({ key: changeKey, to: Number(e.target.value) }) })}
                  />
                </div>
              )}
            </div>
          </div>

          {preview && (
            <div className="space-y-1 border-t border-border pt-4">
              <p className="text-xs tracking-[0.14em] text-muted-foreground uppercase">
                The answer, as it stands
              </p>
              <p className="font-mono text-sm tabular-nums">
                {preview.answer.before.toFixed(2)}
                {preview.answer.after !== undefined && (
                  <>
                    {' → '}
                    {preview.answer.after.toFixed(2)}
                    <span className="ml-2 text-muted-foreground">
                      ({((preview.answer.ratio! - 1) * 100).toFixed(0)}%)
                    </span>
                  </>
                )}
              </p>
              {/* A card whose change moves nothing is a card with no answer,
                  and the author should learn that here rather than six weeks
                  into reviewing it. */}
              {preview.answer.ratio !== undefined && Math.abs(preview.answer.ratio - 1) < 0.02 && (
                <p className="text-xs text-eosin">
                  This change barely moves the answer — there may be nothing to predict.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

const strip = (value: string | undefined) =>
  (value ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').trim()

function parse(value: string | undefined): Record<string, unknown> {
  try {
    const out = JSON.parse(strip(value) || '{}') as unknown
    return out && typeof out === 'object' && !Array.isArray(out) ? (out as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function numbers(source: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(source)) {
    const n = Number(v)
    if (Number.isFinite(n)) out[k] = n
  }
  return out
}
