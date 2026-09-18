import { useSyncExternalStore } from 'react'
import { setSfxEnabled, sfxEnabled, subscribeSfx } from '@/lib/sfx'

/**
 * Reactive view of the UI-sound toggle, for the one screen that renders it.
 *
 * Playback deliberately does not come through here. A hook would tie every
 * sound to a render, and the flip sound has to leave with the flip — so the
 * study loop imports `sfx()` from `lib/sfx` and calls it inside the handler.
 */
export function useSfx() {
  const enabled = useSyncExternalStore(subscribeSfx, sfxEnabled, () => false)
  return { enabled, setEnabled: setSfxEnabled }
}
