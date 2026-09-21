import type { SimModel, SimResult } from './types.ts'
import { resolveParams } from './types.ts'

/**
 * Hodgkin–Huxley: the action potential, from the 1952 paper.
 *
 * Four state variables and four equations, which is remarkable for something
 * that won a Nobel Prize and still runs every neuroscience course:
 *
 *   C·dV/dt = I − gNa·m³h·(V−ENa) − gK·n⁴·(V−EK) − gL·(V−EL)
 *
 * with m, h and n each relaxing toward a voltage-dependent steady state. The
 * powers are the lesson: **m³h** means sodium activates fast and cubed, then
 * inactivates; **n⁴** means potassium is slower and fourth-power, so it arrives
 * late and stays. That ordering *is* the spike — fast depolarisation, then
 * repolarisation, then an undershoot while n is still high.
 *
 * Kept in the original convention, where V is displacement from rest in mV and
 * depolarisation is *negative*. Converting to modern sign would make the
 * constants stop matching every textbook a student has open, which is a worse
 * confusion than the one it solves — so the output is flipped for display
 * instead, and only at the output.
 *
 * Forward Euler at 0.01 ms. The fastest gate here has a time constant of a few
 * tenths of a millisecond, so this is comfortably stable; larger steps make it
 * ring, which is why the step is not a parameter.
 */
export const HODGKIN_HUXLEY: SimModel = {
  id: 'hodgkin-huxley',
  name: 'Action potential (Hodgkin–Huxley)',
  teaches: 'Why the spike has a threshold, and why it undershoots',
  xLabel: 'Time',
  xUnit: 'ms',
  parameters: [
    {
      key: 'current', label: 'Injected current', unit: 'µA/cm²',
      default: 10, min: 0, max: 60, step: 0.5,
      hint: 'Below about 6 nothing fires at all: the threshold is a property of the equations, not a rule bolted on.',
    },
    {
      key: 'gna', label: 'Sodium conductance', unit: 'mS/cm²',
      default: 120, min: 0, max: 200, step: 5,
      hint: 'The upstroke. Drop it and the spike shrinks, then vanishes — this is what a local anaesthetic does.',
    },
    {
      key: 'gk', label: 'Potassium conductance', unit: 'mS/cm²',
      default: 36, min: 0, max: 100, step: 2,
      hint: 'Repolarisation. Drop it and the spike widens.',
    },
    {
      key: 'duration', label: 'Duration', unit: 'ms',
      default: 50, min: 10, max: 200, step: 5,
    },
  ],
  outputs: [
    { key: 'spikes', label: 'Spikes fired', unit: '', precision: 0 },
    { key: 'peak', label: 'Peak membrane potential', unit: 'mV', precision: 1 },
    { key: 'trough', label: 'Deepest undershoot', unit: 'mV', precision: 1 },
    { key: 'rate', label: 'Firing rate', unit: 'Hz', precision: 1 },
  ],

  run(given): SimResult {
    const { current, gna, gk, duration } = resolveParams<'current' | 'gna' | 'gk' | 'duration'>(HODGKIN_HUXLEY, given)

    const C = 1.0      // µF/cm²
    const ENa = 115    // mV, relative to rest
    const EK = -12
    const EL = 10.613
    const gl = 0.3
    const dt = 0.01
    const steps = Math.round(duration / dt)

    // The rate constants, exactly as published. `safeExp` guards the removable
    // singularities at v = 10 and v = 25, where both numerator and denominator
    // vanish; the limit is finite and a naive evaluation is NaN.
    const alphaN = (v: number) => ratio(0.01 * (10 - v), Math.exp((10 - v) / 10) - 1, 0.1)
    const betaN = (v: number) => 0.125 * Math.exp(-v / 80)
    const alphaM = (v: number) => ratio(0.1 * (25 - v), Math.exp((25 - v) / 10) - 1, 1)
    const betaM = (v: number) => 4 * Math.exp(-v / 18)
    const alphaH = (v: number) => 0.07 * Math.exp(-v / 20)
    const betaH = (v: number) => 1 / (Math.exp((30 - v) / 10) + 1)

    let v = 0
    // Started at their resting steady states, so the trace opens flat instead
    // of with a settling transient somebody has to be told to ignore.
    let n = alphaN(0) / (alphaN(0) + betaN(0))
    let m = alphaM(0) / (alphaM(0) + betaM(0))
    let h = alphaH(0) / (alphaH(0) + betaH(0))

    const t: number[] = []
    const potential: number[] = []
    let spikes = 0
    let above = false

    for (let i = 0; i <= steps; i++) {
      const iNa = gna * m ** 3 * h * (v - ENa)
      const iK = gk * n ** 4 * (v - EK)
      const iL = gl * (v - EL)

      v += (dt / C) * (current - iNa - iK - iL)
      n += dt * (alphaN(v) * (1 - n) - betaN(v) * n)
      m += dt * (alphaM(v) * (1 - m) - betaM(v) * m)
      h += dt * (alphaH(v) * (1 - h) - betaH(v) * h)

      // Counted on the upward crossing of a threshold well above any
      // subthreshold wobble, so a slow depolarisation is not mistaken for a
      // train of spikes.
      if (!above && v > 50) {
        spikes++
        above = true
      } else if (above && v < 20) {
        above = false
      }

      t.push(i * dt)
      // Reported relative to a −65 mV rest, which is the axis every textbook
      // draws. The maths above stays in the original convention.
      potential.push(v - 65)
    }

    return {
      scalars: {
        spikes,
        peak: Math.max(...potential),
        trough: Math.min(...potential),
        rate: duration > 0 ? (spikes / duration) * 1000 : 0,
      },
      series: { t, values: { potential } },
    }
  },
}

/**
 * Two-compartment pharmacokinetics: where the drug actually goes.
 *
 *   dA₁/dt = −(k₁₀ + k₁₂)·A₁ + k₂₁·A₂ + input
 *   dA₂/dt =  k₁₂·A₁ − k₂₁·A₂
 *
 * Central compartment (blood and well-perfused organs) and peripheral (fat,
 * muscle). The reason it is worth two compartments rather than one is the shape
 * it produces: a **fast distribution phase** while the drug leaves the blood for
 * the tissues, then a **slow elimination phase** once they equilibrate.
 *
 * That biphasic curve is the answer to half the dosing questions in a
 * pharmacology course. A loading dose exists because of the first phase; a
 * maintenance dose because of the second; and a drug redistributing out of the
 * brain is why a single dose of thiopentone wears off long before it is
 * eliminated.
 */
export const TWO_COMPARTMENT_PK: SimModel = {
  id: 'two-compartment-pk',
  name: 'Drug concentration (two-compartment)',
  teaches: 'Why a drug wears off before it is eliminated',
  xLabel: 'Time',
  xUnit: 'h',
  parameters: [
    { key: 'dose', label: 'Dose', unit: 'mg', default: 500, min: 10, max: 5000, step: 10 },
    {
      key: 'vc', label: 'Central volume', unit: 'L',
      default: 15, min: 2, max: 80, step: 1,
      hint: 'Blood and the organs it reaches at once. Sets the peak concentration.',
    },
    {
      key: 'k10', label: 'Elimination rate (k₁₀)', unit: '1/h',
      default: 0.15, min: 0.01, max: 2, step: 0.01,
      hint: 'Out of the body. Falls in renal or hepatic failure.',
    },
    {
      key: 'k12', label: 'To the periphery (k₁₂)', unit: '1/h',
      default: 0.8, min: 0, max: 3, step: 0.05,
    },
    {
      key: 'k21', label: 'Back from the periphery (k₂₁)', unit: '1/h',
      default: 0.4, min: 0.01, max: 3, step: 0.05,
    },
    {
      key: 'interval', label: 'Redose every', unit: 'h',
      default: 0, min: 0, max: 24, step: 1,
      hint: 'Zero is a single dose. Anything else shows accumulation to steady state.',
    },
    { key: 'hours', label: 'Hours to simulate', unit: 'h', default: 24, min: 2, max: 168, step: 2 },
  ],
  outputs: [
    { key: 'peak', label: 'Peak concentration', unit: 'mg/L', precision: 2 },
    { key: 'trough', label: 'Trough at the end', unit: 'mg/L', precision: 2 },
    { key: 'halfLife', label: 'Terminal half-life', unit: 'h', precision: 1 },
    { key: 'auc', label: 'Area under the curve', unit: 'mg·h/L', precision: 1 },
  ],

  run(given): SimResult {
    const { dose, vc, k10, k12, k21, interval, hours } = resolveParams<'dose' | 'vc' | 'k10' | 'k12' | 'k21' | 'interval' | 'hours'>(TWO_COMPARTMENT_PK, given)

    const dt = 0.01
    const steps = Math.round(hours / dt)

    let central = dose
    let peripheral = 0
    let nextDose = interval > 0 ? interval : Infinity

    const t: number[] = []
    const concentration: number[] = []
    let auc = 0

    for (let i = 0; i <= steps; i++) {
      const time = i * dt

      if (time >= nextDose) {
        central += dose
        nextDose += interval
      }

      const c = central / vc
      concentration.push(c)
      t.push(time)
      auc += c * dt

      const toPeripheral = k12 * central
      const fromPeripheral = k21 * peripheral

      central += dt * (-(k10 * central) - toPeripheral + fromPeripheral)
      peripheral += dt * (toPeripheral - fromPeripheral)
    }

    return {
      scalars: {
        peak: Math.max(...concentration),
        trough: concentration[concentration.length - 1] ?? 0,
        // The *terminal* half-life, read off the slow phase rather than
        // assumed from k₁₀ — which is the number that matters and the number a
        // one-compartment intuition gets wrong.
        halfLife: terminalHalfLife(k10, k12, k21),
        auc,
      },
      series: { t, values: { concentration } },
    }
  },
}

/**
 * The slower of the two exponentials the system decays with.
 *
 * The eigenvalues of the 2×2 rate matrix. β is the smaller root and governs the
 * tail, so the terminal half-life is ln2/β — reliably *longer* than ln2/k₁₀,
 * because the periphery keeps handing drug back long after the blood has
 * cleared.
 */
function terminalHalfLife(k10: number, k12: number, k21: number): number {
  const sum = k10 + k12 + k21
  const root = Math.sqrt(Math.max(0, sum * sum - 4 * k10 * k21))
  const beta = (sum - root) / 2

  return beta > 0 ? Math.LN2 / beta : Infinity
}

/**
 * `numerator / denominator`, with the limit substituted where both vanish.
 *
 * Hodgkin and Huxley's α terms have removable singularities at v = 10 and
 * v = 25. The function is perfectly well behaved there; the *expression* is
 * 0/0, and evaluating it naively puts a NaN into the membrane potential that
 * poisons every step after it.
 */
function ratio(numerator: number, denominator: number, limit: number): number {
  return Math.abs(denominator) < 1e-9 ? limit : numerator / denominator
}
