/**
 * The models, checked as physiology rather than as arithmetic.
 *
 * A simulation card is only worth scheduling if the curve it draws is right, and
 * "right" here does not mean "matches a number I recorded from my own code" —
 * that only pins the output to whatever it happened to be. So these assert
 * things that are true of the *system*: closed forms where one exists, the
 * direction each parameter moves its outputs, and the qualitative behaviour the
 * card is teaching. A refactor that changed the answer would have to change
 * physiology to pass.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HODGKIN_HUXLEY, SIM_MODELS, TWO_COMPARTMENT_PK, VENTRICULAR_COUPLING, WINDKESSEL,
  resolveParams, runSimCard, simModel,
} from './index.ts'

// ── ventricular coupling ────────────────────────────────────────────────────

test('stroke volume matches the closed form it is derived from', () => {
  // SV = Ees·(EDV − V₀) / (Ees + Ea). Algebraic, so this is exact rather than
  // approximate, and any drift is a bug rather than a timestep.
  const { scalars } = VENTRICULAR_COUPLING.run({ edv: 120, ees: 2, ea: 1.6, v0: 15, hr: 70 })
  const expected = (2 * (120 - 15)) / (2 + 1.6)

  assert.ok(Math.abs(scalars.sv! - expected) < 1e-9)
  assert.ok(Math.abs(scalars.esv! - (120 - expected)) < 1e-9, 'ESV is what did not leave')
})

test('doubling afterload does NOT halve stroke volume — the whole point of the card', () => {
  // Most people predict a halving. The truth is Ea sits in a denominator with
  // Ees, so the fall depends on how the two compare: a strong ventricle barely
  // notices, a failing one collapses. That is the lesson, and it is why this
  // is a prediction card rather than a fact.
  const run = runSimCard({
    model: 'ventricular-coupling',
    params: { edv: 120, ees: 2, ea: 1.6, v0: 15 },
    change: { key: 'ea', to: 3.2 },
    target: 'sv',
  })!

  assert.ok(run.answer.ratio! > 0.5, 'it falls by much less than half')
  assert.ok(run.answer.ratio! < 1, 'but it does fall')
  // (Ees + Ea) / (Ees + 2·Ea) = 3.6 / 5.2
  assert.ok(Math.abs(run.answer.ratio! - 3.6 / 5.2) < 1e-9)
})

test('a strong ventricle tolerates afterload better than a weak one', () => {
  const fall = (ees: number) => {
    const run = runSimCard({
      model: 'ventricular-coupling',
      params: { edv: 120, ees, ea: 1.6, v0: 15 },
      change: { key: 'ea', to: 3.2 },
      target: 'sv',
    })!
    return run.answer.ratio!
  }

  assert.ok(fall(4) > fall(0.8), 'contractility buys afterload tolerance')
})

test('preload raises stroke volume', () => {
  const sv = (edv: number) => VENTRICULAR_COUPLING.run({ edv, ees: 2, ea: 1.6, v0: 15 }).scalars.sv!

  assert.ok(sv(160) > sv(120), 'Frank–Starling, without a curve fit')
  assert.ok(sv(120) > sv(80))
})

test('a ventricle filled only to its unstressed volume ejects nothing', () => {
  // Severe hypovolaemia, and the one case where the closed form would go
  // negative. Reached here by raising V₀ rather than dropping EDV below the
  // model's own floor, because that floor is doing its job.
  const sv = (edv: number, v0: number) =>
    VENTRICULAR_COUPLING.run({ edv, v0, ees: 2, ea: 1.6 }).scalars.sv!

  assert.equal(sv(60, 60), 0, 'nothing above the unstressed volume')
  assert.equal(sv(40, 60), 0, 'and it never goes negative')
  assert.ok(sv(80, 60) > 0)
})

test('the pressure-volume loop closes and spans the stroke volume', () => {
  const { series, scalars } = VENTRICULAR_COUPLING.run({ edv: 120, ees: 2, ea: 1.6, v0: 15 })

  assert.ok(series)
  assert.equal(series!.t[0], series!.t.at(-1), 'the loop returns to where it started')
  assert.ok(Math.abs((Math.max(...series!.t) - Math.min(...series!.t)) - scalars.sv!) < 1e-9,
    'its width is the stroke volume')
})

// ── windkessel ──────────────────────────────────────────────────────────────

test('the decay time constant is R·C, read straight off the parameters', () => {
  const { scalars } = WINDKESSEL.run({ r: 1.2, c: 1.5 })
  assert.ok(Math.abs(scalars.tau! - 1.8) < 1e-9)
})

test('a stiffer aorta widens the pulse pressure', () => {
  // Arterial ageing in one slider, and the reason isolated systolic
  // hypertension exists. Same flow, same resistance, less compliance.
  const stretchy = WINDKESSEL.run({ r: 1, c: 2.5, sv: 70, hr: 70 }).scalars
  const stiff = WINDKESSEL.run({ r: 1, c: 0.5, sv: 70, hr: 70 }).scalars

  assert.ok(stiff.pulse! > stretchy.pulse! * 2, 'markedly wider')
  assert.ok(stiff.systolic! > stretchy.systolic!, 'driven by a higher systolic')
  assert.ok(stiff.diastolic! < stretchy.diastolic!, 'and a lower diastolic')
  // The mean is set by flow and resistance, not by compliance, so it barely
  // moves — which is exactly why a stiff artery is missed by a mean pressure.
  assert.ok(Math.abs(stiff.mean! - stretchy.mean!) / stretchy.mean! < 0.15)
})

test('mean pressure follows flow times resistance', () => {
  const low = WINDKESSEL.run({ r: 0.8, c: 1.5, sv: 70, hr: 70 }).scalars.mean!
  const high = WINDKESSEL.run({ r: 1.6, c: 1.5, sv: 70, hr: 70 }).scalars.mean!

  assert.ok(high > low * 1.7, 'doubling resistance nearly doubles the mean')
  // MAP ≈ CO × R. CO here is 70 mL × 70/60 per second.
  assert.ok(Math.abs(high - (70 * 70 / 60) * 1.6) / high < 0.1)
})

test('systolic is above diastolic and both are physiological', () => {
  const { scalars } = WINDKESSEL.run({})

  assert.ok(scalars.systolic! > scalars.diastolic!)
  assert.ok(scalars.mean! > scalars.diastolic! && scalars.mean! < scalars.systolic!)
  assert.ok(scalars.systolic! > 80 && scalars.systolic! < 200, `systolic ${scalars.systolic}`)
})

// ── hodgkin–huxley ──────────────────────────────────────────────────────────

test('there is a firing threshold, and it emerges from the equations', () => {
  // Nothing in the model says "threshold". It falls out of sodium activating
  // faster than potassium, which is the single most important thing about the
  // 1952 paper and the hardest thing to get from a definition.
  const quiet = HODGKIN_HUXLEY.run({ current: 2, duration: 50 }).scalars
  const firing = HODGKIN_HUXLEY.run({ current: 15, duration: 50 }).scalars

  assert.equal(quiet.spikes, 0, 'a small current does nothing at all')
  assert.ok(firing.spikes! >= 2, 'a larger one fires repeatedly')
})

test('more current fires faster', () => {
  const slow = HODGKIN_HUXLEY.run({ current: 10, duration: 100 }).scalars.rate!
  const fast = HODGKIN_HUXLEY.run({ current: 40, duration: 100 }).scalars.rate!

  assert.ok(fast > slow, `${fast} Hz should beat ${slow} Hz`)
})

test('blocking sodium abolishes the spike', () => {
  // Which is what a local anaesthetic does, and the test is the mechanism.
  const blocked = HODGKIN_HUXLEY.run({ current: 20, gna: 0, duration: 50 }).scalars
  assert.equal(blocked.spikes, 0)
})

test('the spike overshoots zero and undershoots rest', () => {
  const { scalars } = HODGKIN_HUXLEY.run({ current: 15, duration: 50 })

  assert.ok(scalars.peak! > 0, 'it overshoots into positive territory')
  assert.ok(scalars.trough! < -65, 'and undershoots rest while potassium is still open')
  assert.ok(Number.isFinite(scalars.peak!), 'the rate constants did not produce a NaN')
})

test('the removable singularities in the rate constants do not poison the trace', () => {
  // α_n and α_m are 0/0 at v = 10 and v = 25. A naive evaluation puts a NaN
  // into the membrane potential and every step after it inherits it.
  const { series } = HODGKIN_HUXLEY.run({ current: 12, duration: 60 })
  assert.ok(series!.values.potential!.every(Number.isFinite), 'no NaN anywhere in the trace')
})

// ── two-compartment PK ──────────────────────────────────────────────────────

test('the peak is the dose spread through the central compartment', () => {
  const { scalars } = TWO_COMPARTMENT_PK.run({ dose: 500, vc: 25, interval: 0 })
  assert.ok(Math.abs(scalars.peak! - 20) < 0.01, '500 mg into 25 L')
})

test('the terminal half-life is longer than elimination alone implies', () => {
  // The reason two compartments are worth modelling. A one-compartment
  // intuition reads ln2/k₁₀ and is wrong, because the periphery keeps handing
  // drug back long after the blood has cleared.
  const { scalars } = TWO_COMPARTMENT_PK.run({ k10: 0.15, k12: 0.8, k21: 0.4 })
  const naive = Math.LN2 / 0.15

  assert.ok(scalars.halfLife! > naive, `${scalars.halfLife} should exceed ${naive}`)
})

test('with no peripheral compartment it collapses to the one-compartment answer', () => {
  // The degenerate case is a check on the eigenvalue: with k₁₂ = 0 there is
  // nowhere to distribute to, so the terminal half-life must be ln2/k₁₀.
  const { scalars } = TWO_COMPARTMENT_PK.run({ k10: 0.2, k12: 0, k21: 0.4 })
  assert.ok(Math.abs(scalars.halfLife! - Math.LN2 / 0.2) < 1e-6)
})

test('the curve is biphasic: a fast fall, then a slow one', () => {
  // The shape that explains why a single dose of an anaesthetic wears off long
  // before it is eliminated.
  const { series } = TWO_COMPARTMENT_PK.run({ k10: 0.1, k12: 1.2, k21: 0.3, hours: 24, interval: 0 })
  const c = series!.values.concentration!
  const at = (h: number) => c[Math.round((h / 24) * (c.length - 1))]!

  const early = (at(0) - at(1)) / at(0)
  const late = (at(12) - at(13)) / at(12)

  assert.ok(early > late * 2, 'the distribution phase falls much faster than elimination')
})

test('redosing accumulates toward a steady state', () => {
  const single = TWO_COMPARTMENT_PK.run({ hours: 48, interval: 0 }).scalars.trough!
  const repeated = TWO_COMPARTMENT_PK.run({ hours: 48, interval: 8 }).scalars.trough!

  assert.ok(repeated > single * 2, 'a maintenance schedule holds a level')
})

// ── the registry ────────────────────────────────────────────────────────────

test('an unknown model runs nothing rather than anything', () => {
  // A card can arrive from an imported Anki deck or a cloned marketplace
  // listing, so the model name is untrusted input.
  assert.equal(simModel('../../etc/passwd'), null)
  assert.equal(runSimCard({ model: 'not-a-model', params: {}, target: 'sv' }), null)
})

test('parameters are clamped, not trusted', () => {
  // A negative resistance divides by zero three lines into a differential
  // equation, and the card that carries it may be somebody else's.
  const params = resolveParams(WINDKESSEL, { r: -5, c: 999, sv: Number.NaN })

  assert.ok(params.r! >= 0.2 && params.c! <= 4)
  assert.equal(params.sv, 70, 'a NaN falls back to the default')
})

test('every model declares what a card may ask about, and answers all of it', () => {
  for (const model of SIM_MODELS) {
    assert.ok(model.parameters.length > 0, `${model.id} has parameters`)
    assert.ok(model.outputs.length > 0, `${model.id} has outputs`)

    const result = model.run({})
    for (const output of model.outputs) {
      const value = result.scalars[output.key]
      assert.ok(typeof value === 'number' && Number.isFinite(value),
        `${model.id}.${output.key} returned ${value}`)
    }

    for (const p of model.parameters) {
      assert.ok(p.default >= p.min && p.default <= p.max, `${model.id}.${p.key} default is in range`)
    }
  }
})

test('a model with no change asked of it still answers the baseline', () => {
  const run = runSimCard({ model: 'windkessel', params: { r: 1.2 }, target: 'tau' })!

  assert.ok(Math.abs(run.answer.before - 1.8) < 1e-9)
  assert.equal(run.answer.after, undefined)
  assert.equal(run.changed, undefined)
})
