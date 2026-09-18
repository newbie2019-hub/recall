import { Rating, type RatingValue } from '@recall/core'
import { play, unlockAudio, type Tone } from './audio'

/**
 * UI sound for the study loop, off by default.
 *
 * Latency is the whole product: a flip sound that lands 200ms after the flip is
 * worse than silence. So `sfx()` is a plain module function called straight
 * from the handler that does the thing — not a hook, not an effect that fires
 * after React commits. `useSfx` exists only for the settings toggle, which is
 * the one place that needs to re-render when the value changes.
 *
 * Nothing here is a melody. The four ratings share one short blip and differ in
 * pitch and timbre, so Again and Easy are plainly different events without the
 * session turning into a tune you notice by the fiftieth card.
 */

export type SfxName = 'flip' | 'again' | 'hard' | 'good' | 'easy' | 'undo' | 'complete'

const VOICES: Record<SfxName, Tone[]> = {
  // Quietest thing here: it fires on every single card.
  flip: [{ freq: 1100, to: 1500, ms: 45, gain: 0.025 }],
  again: [{ freq: 200, to: 130, ms: 160, type: 'square', gain: 0.035 }],
  hard: [{ freq: 330, ms: 95, type: 'triangle' }],
  good: [{ freq: 560, ms: 80 }],
  easy: [{ freq: 790, to: 960, ms: 120 }],
  undo: [{ freq: 540, to: 340, ms: 140, type: 'triangle' }],
  complete: [
    { freq: 620, ms: 130, gain: 0.07 },
    { freq: 930, ms: 260, at: 120, gain: 0.07 },
  ],
}

export const RATING_SFX: Record<RatingValue, SfxName> = {
  [Rating.Again]: 'again',
  [Rating.Hard]: 'hard',
  [Rating.Good]: 'good',
  [Rating.Easy]: 'easy',
}

const KEY = 'recall.sfx'

// localStorage rather than a row in the collection: this is a property of this
// device's speakers, not of the cards, and syncing it would mean a phone on a
// bus inherits a desk setup.
let on = false
try {
  on = localStorage.getItem(KEY) === '1'
} catch {
  // Private mode or blocked storage. Silent is the safe default.
}

const listeners = new Set<() => void>()

export const sfxEnabled = () => on

export function setSfxEnabled(next: boolean): void {
  on = next
  try {
    localStorage.setItem(KEY, next ? '1' : '0')
  } catch {
    // Not persisting is survivable; refusing to switch the sound on is not.
  }
  // The toggle is itself a gesture, so unlock here — otherwise the context is
  // first created by the flip sound, which is then the one sound nobody hears.
  // Playing one immediately also answers "is it working?" without a card.
  if (next) {
    unlockAudio()
    sfx('good')
  }
  for (const l of listeners) l()
}

export function subscribeSfx(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Call from the event handler, before the state update, not after it. */
export function sfx(name: SfxName): void {
  if (!on) return
  play(VOICES[name])
}
