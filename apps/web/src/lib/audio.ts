/**
 * One AudioContext for the whole app, and the one primitive every sound in it
 * is built from.
 *
 * A context constructed at module load starts `suspended`, and the first sound
 * played through it is silently swallowed — browsers only let it start inside a
 * user gesture. So it is created on the way through the first click (starting a
 * timer, rating a card) and every later, gesture-less sound — the end-of-block
 * chime fires from a timer, not a tap — finds a context that is already
 * running.
 *
 * Everything is synthesised. Six short blips as .mp3 would cost bytes, a
 * loading state and a licence question to reproduce what a gain ramp does in
 * four lines.
 */

export interface Tone {
  freq: number
  ms: number
  /** Slide target — an audible shape without a second note. */
  to?: number
  /** Offset from now, in ms, so a two-note cue is still one call. */
  at?: number
  type?: OscillatorType
  gain?: number
}

let ctx: AudioContext | null = null

/**
 * Get the shared context, creating it if this is the first time. Call it from
 * a click handler: called anywhere else on a fresh page it returns a suspended
 * context and the sound is lost.
 */
export function unlockAudio(): AudioContext | null {
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch {
    // No WebAudio at all. Sound is decoration here; it never becomes an error
    // the user has to read.
    return null
  }
}

/**
 * `prefers-reduced-sound` is reduced-motion's audio sibling. No engine ships it
 * yet, so `matchMedia` reports `false` and this is a no-op — it costs one line
 * now and starts working on its own the day a browser honours it.
 *
 * ponytail: media query only. If users ask for a volume control, that is a
 * stored gain multiplier applied in `play`, not a rewrite.
 */
export const audible = () =>
  !document.hidden && !matchMedia('(prefers-reduced-sound: reduce)').matches

export function play(tones: Tone[]): void {
  if (!audible()) return
  const c = unlockAudio()
  if (!c) return

  for (const t of tones) {
    const start = c.currentTime + (t.at ?? 0) / 1000
    const end = start + t.ms / 1000

    const osc = c.createOscillator()
    osc.type = t.type ?? 'sine'
    osc.frequency.setValueAtTime(t.freq, start)
    if (t.to) osc.frequency.exponentialRampToValueAtTime(t.to, end)

    // Ramped, never stepped: a gain that jumps to or from zero produces a click
    // louder than the tone it was supposed to bound. Exponential ramps cannot
    // touch zero, hence the epsilon endpoints.
    const g = c.createGain()
    g.gain.setValueAtTime(0.0001, start)
    g.gain.exponentialRampToValueAtTime(t.gain ?? 0.05, start + 0.008)
    g.gain.exponentialRampToValueAtTime(0.0001, end)

    osc.connect(g).connect(c.destination)
    osc.start(start)
    osc.stop(end + 0.02)
  }
}

/**
 * End of a focus or break block. Deliberately longer and louder than the UI
 * feedback in `sfx.ts` — this one has to carry from across the room, and it
 * plays whether or not UI sounds are switched on, because it is the alarm the
 * user asked for when they started the timer.
 */
export const chime = () =>
  play([
    { freq: 660, ms: 180, gain: 0.09 },
    { freq: 880, ms: 320, at: 170, gain: 0.09 },
  ])
