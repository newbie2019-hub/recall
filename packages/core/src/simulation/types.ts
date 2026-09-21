/**
 * Simulation cards: parameters in, a curve out, and a prediction in between.
 *
 * The card this exists for is *"afterload doubles — predict the change in
 * stroke volume."* You answer, then the model runs and draws what actually
 * happens against what you said, and FSRS schedules it like any other card.
 * Nothing else in the product tests whether you can *use* a fact rather than
 * recite one.
 *
 * Three rules shape every model in here:
 *
 * **It is arithmetic, so it works offline.** No solver library, no service, no
 * network. Forward Euler at a small step is accurate enough to teach with, and
 * a model that needed a server would break the app's first promise.
 *
 * **It lives in `packages/core`,** with no DOM and no React, so the eventual
 * React Native client inherits it unchanged — and so the models can be tested
 * as maths rather than through a screen.
 *
 * **The note supplies numbers, never code.** A simulation card's fields carry a
 * model *name* and parameter values. The model itself is ours. That is what
 * lets the result render as a real interactive chart outside the sandboxed
 * `CardFrame` without breaking README rule 5 — there is nothing untrusted to
 * execute, because nothing authored by a user or a model is ever run.
 */

export interface SimParameter {
  key: string
  label: string
  unit: string
  default: number
  min: number
  max: number
  /** Slider granularity, and the precision the value is shown to. */
  step: number
  /** One line on what this actually is, shown beside the control. */
  hint?: string
}

export interface SimOutput {
  key: string
  label: string
  unit: string
  /** Sensible decimal places for a readout. */
  precision: number
}

export interface SimSeries {
  /** The x axis, already in `xUnit`. */
  t: number[]
  /** One entry per plotted trace, keyed by output key. */
  values: Record<string, number[]>
}

export interface SimResult {
  /** The curve, when the model has one. Algebraic models return no series. */
  series?: SimSeries
  /** Single numbers the card can ask about. */
  scalars: Record<string, number>
}

export interface SimModel {
  id: string
  name: string
  /** What a card built on this teaches. Shown in the editor, not on the card. */
  teaches: string
  parameters: SimParameter[]
  /** Everything predictable. A card names one of these as its target. */
  outputs: SimOutput[]
  /** Axis labels for the chart, when there is a series. */
  xLabel?: string
  xUnit?: string
  run(params: Record<string, number>): SimResult
}

/**
 * Fill in the defaults a card did not override, and clamp what it did.
 *
 * Generic over the model's own keys so the result is a mapped type rather than
 * an index signature: every declared parameter really is present, and the
 * compiler can be told so once here instead of being argued with at each of the
 * two dozen places a model reads one.
 */
export function resolveParams<K extends string>(
  model: SimModel,
  given: Record<string, number>,
): Record<K, number> {
  const out = {} as Record<K, number>

  for (const p of model.parameters) {
    const value = given[p.key]
    out[p.key as K] = value === undefined || !Number.isFinite(value)
      ? p.default
      // Clamped rather than trusted: a card is content, it can be imported
      // from a stranger's deck, and a negative resistance divides by zero
      // somewhere three lines into a differential equation.
      : Math.min(p.max, Math.max(p.min, value))
  }

  return out
}
