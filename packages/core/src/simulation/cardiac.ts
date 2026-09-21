import type { SimModel, SimResult } from './types.ts'
import { resolveParams } from './types.ts'

/**
 * Two cardiovascular models: how much blood leaves, and what the pressure does.
 *
 * Between them they cover the three words every physiology course spends a term
 * on — preload, afterload, contractility — and they cover them as *behaviour*
 * rather than as definitions, which is the whole argument for this card kind.
 */

/**
 * Ventricular–arterial coupling. The headline card.
 *
 * The elastance framework, which is the standard teaching model and is
 * algebraic rather than numerical, so there is nothing to integrate and nothing
 * to get wrong in a timestep:
 *
 *   ESPVR (the ventricle):   ESP = Ees · (ESV − V₀)
 *   Arterial load:           ESP = Ea · SV = Ea · (EDV − ESV)
 *
 * Setting them equal and solving for ESV gives a closed form:
 *
 *   SV = Ees · (EDV − V₀) / (Ees + Ea)
 *
 * Read that expression and the three levers fall out of it. **Preload** (EDV)
 * raises SV linearly — Frank–Starling, without a curve-fit. **Contractility**
 * (Ees) raises it with diminishing returns. **Afterload** (Ea) is in the
 * denominator, so doubling it does *not* halve stroke volume, which is exactly
 * the intuition the card exists to correct: most people predict a halving.
 *
 * Ea is the honest handle for afterload here. It is not arterial resistance —
 * it is end-systolic pressure over stroke volume, the load the ventricle
 * actually ejects against, and it is what rises when resistance rises.
 */
export const VENTRICULAR_COUPLING: SimModel = {
  id: 'ventricular-coupling',
  name: 'Stroke volume: preload, afterload, contractility',
  teaches: 'Why doubling afterload does not halve stroke volume',
  xLabel: 'Volume',
  xUnit: 'mL',
  parameters: [
    {
      key: 'edv', label: 'End-diastolic volume (preload)', unit: 'mL',
      default: 120, min: 40, max: 250, step: 5,
      hint: 'How full the ventricle is before it contracts.',
    },
    {
      key: 'ees', label: 'End-systolic elastance (contractility)', unit: 'mmHg/mL',
      default: 2.0, min: 0.3, max: 8, step: 0.1,
      hint: 'How hard it squeezes. Rises with inotropes, falls in heart failure.',
    },
    {
      key: 'ea', label: 'Arterial elastance (afterload)', unit: 'mmHg/mL',
      default: 1.6, min: 0.2, max: 10, step: 0.1,
      hint: 'The load ejected against. Rises with vasoconstriction.',
    },
    {
      key: 'v0', label: 'Unstressed volume (V₀)', unit: 'mL',
      default: 15, min: 0, max: 60, step: 1,
      hint: 'The volume at which the ventricle generates no pressure.',
    },
    {
      key: 'hr', label: 'Heart rate', unit: 'bpm',
      default: 70, min: 30, max: 200, step: 5,
    },
  ],
  outputs: [
    { key: 'sv', label: 'Stroke volume', unit: 'mL', precision: 1 },
    { key: 'ef', label: 'Ejection fraction', unit: '%', precision: 1 },
    { key: 'esp', label: 'End-systolic pressure', unit: 'mmHg', precision: 1 },
    { key: 'co', label: 'Cardiac output', unit: 'L/min', precision: 2 },
    { key: 'esv', label: 'End-systolic volume', unit: 'mL', precision: 1 },
  ],

  run(given): SimResult {
    const { edv, ees, ea, v0, hr } = resolveParams<'edv' | 'ees' | 'ea' | 'v0' | 'hr'>(VENTRICULAR_COUPLING, given)

    // A ventricle that cannot fill past its unstressed volume ejects nothing.
    // Physiologically real (severe hypovolaemia) and it must not go negative.
    const filled = Math.max(0, edv - v0)
    const sv = (ees * filled) / (ees + ea)
    const esv = edv - sv

    return {
      scalars: {
        sv,
        esv,
        ef: edv > 0 ? (sv / edv) * 100 : 0,
        esp: ea * sv,
        co: (sv * hr) / 1000,
      },
      // The pressure–volume loop, as the four corners every textbook draws:
      // fill, isovolumetric contraction, eject, isovolumetric relaxation.
      series: {
        t: [esv, edv, edv, esv, esv],
        values: {
          pressure: [0, 0, ea * sv, ea * sv, 0],
        },
      },
    }
  },
}

/**
 * Two-element Windkessel: what the aorta does between beats.
 *
 *   C · dP/dt + P/R = Q(t)
 *
 * A compliance and a resistance, which is a capacitor and a resistor, which is
 * why the pressure decays exponentially once the valve shuts — with a time
 * constant τ = R·C that a student can read straight off the curve. Inflow is a
 * half-sine over systole and zero after it, which is crude and is the right
 * amount of crude: the shape of the decay is the lesson.
 *
 * What it teaches that a definition cannot: stiffening the aorta (lower C)
 * *widens* the pulse pressure without changing the mean much, which is arterial
 * ageing in one slider.
 *
 * Integrated with forward Euler at 1 ms. The time constant here is on the order
 * of a second, so the step is three orders of magnitude below it — far inside
 * where Euler is honest.
 */
export const WINDKESSEL: SimModel = {
  id: 'windkessel',
  name: 'Aortic pressure (2-element Windkessel)',
  teaches: 'Why stiff arteries widen the pulse pressure',
  xLabel: 'Time',
  xUnit: 's',
  parameters: [
    {
      key: 'r', label: 'Peripheral resistance', unit: 'mmHg·s/mL',
      default: 1.0, min: 0.2, max: 4, step: 0.05,
      hint: 'The arterioles. Rises with vasoconstriction.',
    },
    {
      key: 'c', label: 'Arterial compliance', unit: 'mL/mmHg',
      default: 1.5, min: 0.2, max: 4, step: 0.05,
      hint: 'How stretchy the aorta is. Falls with age.',
    },
    {
      key: 'sv', label: 'Stroke volume', unit: 'mL',
      default: 70, min: 20, max: 150, step: 5,
    },
    {
      key: 'hr', label: 'Heart rate', unit: 'bpm',
      default: 70, min: 30, max: 200, step: 5,
    },
    {
      key: 'beats', label: 'Beats to simulate', unit: '',
      default: 6, min: 2, max: 20, step: 1,
    },
  ],
  outputs: [
    { key: 'systolic', label: 'Systolic pressure', unit: 'mmHg', precision: 0 },
    { key: 'diastolic', label: 'Diastolic pressure', unit: 'mmHg', precision: 0 },
    { key: 'pulse', label: 'Pulse pressure', unit: 'mmHg', precision: 0 },
    { key: 'mean', label: 'Mean arterial pressure', unit: 'mmHg', precision: 0 },
    { key: 'tau', label: 'Decay time constant (R·C)', unit: 's', precision: 2 },
  ],

  run(given): SimResult {
    const { r, c, sv, hr, beats } = resolveParams<'r' | 'c' | 'sv' | 'hr' | 'beats'>(WINDKESSEL, given)

    const cycle = 60 / hr
    // Systole shortens with rate, but far less than diastole does — which is
    // why tachycardia costs filling time. Capped so it cannot swallow the
    // cycle at 200 bpm.
    const systole = Math.min(0.3, cycle * 0.4)
    const dt = 0.001
    const steps = Math.round((cycle * beats) / dt)

    // Start at the steady-state mean rather than zero, so the first beat is
    // not a transient the student has to be told to ignore.
    let p = (sv * hr / 60) * r
    const t: number[] = []
    const pressure: number[] = []

    // Peak of a half-sine delivering exactly `sv` over `systole`.
    const peakFlow = (sv * Math.PI) / (2 * systole)

    for (let i = 0; i <= steps; i++) {
      const time = i * dt
      const phase = time % cycle
      const q = phase < systole ? peakFlow * Math.sin((Math.PI * phase) / systole) : 0

      p += (dt / c) * (q - p / r)

      t.push(time)
      pressure.push(p)
    }

    // Measured over the last beat only: the first few are still settling, and
    // quoting a systolic from a transient is how a model lies.
    const lastBeat = Math.max(0, pressure.length - Math.round(cycle / dt))
    const settled = pressure.slice(lastBeat)
    const systolic = Math.max(...settled)
    const diastolic = Math.min(...settled)

    return {
      scalars: {
        systolic,
        diastolic,
        pulse: systolic - diastolic,
        mean: settled.reduce((s, v) => s + v, 0) / settled.length,
        tau: r * c,
      },
      series: { t, values: { pressure } },
    }
  },
}
