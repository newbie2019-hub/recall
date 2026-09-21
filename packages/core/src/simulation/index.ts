import { HODGKIN_HUXLEY, TWO_COMPARTMENT_PK } from './neuron.ts'
import { VENTRICULAR_COUPLING, WINDKESSEL } from './cardiac.ts'
import type { SimModel, SimResult } from './types.ts'
import { resolveParams } from './types.ts'

export * from './types.ts'
export { VENTRICULAR_COUPLING, WINDKESSEL } from './cardiac.ts'
export { HODGKIN_HUXLEY, TWO_COMPARTMENT_PK } from './neuron.ts'

/**
 * Every model a card may name.
 *
 * A registry rather than a dynamic import, because **a card supplies a string
 * and this decides what runs.** A note can be imported from an Anki deck or
 * cloned from a stranger's marketplace listing, so the model name is untrusted
 * input; an unknown one yields nothing rather than anything.
 */
export const SIM_MODELS: SimModel[] = [
  VENTRICULAR_COUPLING,
  WINDKESSEL,
  HODGKIN_HUXLEY,
  TWO_COMPARTMENT_PK,
]

export const simModel = (id: string): SimModel | null =>
  SIM_MODELS.find((m) => m.id === id) ?? null

/**
 * Run a card's simulation, twice: as authored, and with one parameter changed.
 *
 * The "and with one changed" is the card kind's whole reason to exist. *"What
 * happens to stroke volume if afterload doubles?"* is a comparison, and asking
 * a student to hold the baseline in their head while reading a single curve
 * asks them to do the part that is not the lesson.
 */
export interface SimCard {
  model: string
  /** Overrides on the model's defaults. */
  params: Record<string, number>
  /** The parameter the question changes, if it changes one. */
  change?: { key: string; to: number }
  /** Which output the student is predicting. */
  target: string
}

export interface SimRun {
  model: SimModel
  baseline: SimResult
  /** Absent when the card asks about a single condition rather than a change. */
  changed?: SimResult
  /** The value being predicted, before and after. */
  answer: { before: number; after?: number; ratio?: number }
}

export function runSimCard(card: SimCard): SimRun | null {
  const model = simModel(card.model)
  if (!model) return null

  const params = resolveParams(model, card.params ?? {})
  const baseline = model.run(params)
  const before = baseline.scalars[card.target] ?? 0

  if (!card.change || !model.parameters.some((p) => p.key === card.change!.key)) {
    return { model, baseline, answer: { before } }
  }

  const changed = model.run(resolveParams(model, { ...params, [card.change.key]: card.change.to }))
  const after = changed.scalars[card.target] ?? 0

  return {
    model,
    baseline,
    changed,
    // The ratio is what the question is usually really asking — "does it
    // halve?" — and computing it here keeps every screen from doing it
    // slightly differently.
    answer: { before, after, ratio: before === 0 ? 0 : after / before },
  }
}
