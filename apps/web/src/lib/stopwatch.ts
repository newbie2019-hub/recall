/**
 * How long a card was actually in front of somebody.
 *
 * The app already recorded an answer time — `Date.now() - shownAt` — and it was
 * wrong in a way that only shows up once you try to build a dashboard on it.
 * Leave a card open over lunch and that one review is logged as forty-seven
 * minutes; leave it overnight and a single card outweighs a year of honest
 * study. Every median, every per-deck total and every "minutes today" figure
 * inherits that, so the clock has to be fixed before any of them mean anything.
 *
 * Two corrections, both standard:
 *
 * - **The clock stops when the page is hidden.** A backgrounded tab is not
 *   study time, and `visibilitychange` catches the overwhelming majority of
 *   walking away — closing a laptop, switching tabs, locking a phone.
 * - **It also stops after {@link IDLE_MS} of no input.** Visibility misses the
 *   case of staring out of the window with the tab in front of you. This is the
 *   "engaged time" convention web analytics has used for years: a short idle
 *   cutoff, resumed by any real interaction.
 *
 * What it deliberately does *not* do is cap the total — that belongs at the
 * write, next to the deck's `max_answer_seconds`, because the cap is a
 * collection-level policy and this is a clock.
 *
 * ponytail: listeners are attached per stopwatch, one at a time, because
 * exactly one card is on screen at once. If several ever run together, hoist
 * them to a single shared listener with a subscriber set.
 */

/** Long enough not to punish thinking, short enough to catch a coffee break. */
export const IDLE_MS = 30_000

const ACTIVITY = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const

export interface Stopwatch {
  /** Milliseconds the page was visible, focused and not idle. */
  elapsed(): number
  /** Detach the listeners. Always call it; a stopwatch outlives its card. */
  stop(): void
}

export function stopwatch(now: () => number = Date.now): Stopwatch {
  let accumulated = 0
  let running = true
  let since = now()
  let lastActivity = since

  /**
   * Stop the clock *as of* a moment, which is not always "now".
   *
   * Going idle is discovered late — either on the next tick or when somebody
   * finally answers — and crediting the whole gap would count the coffee break
   * it exists to exclude. Idle credits up to {@link IDLE_MS} past the last
   * interaction, because reading a card without touching anything is still
   * studying; everything after that is not.
   */
  const pauseAt = (at: number) => {
    if (!running) return
    accumulated += Math.max(0, Math.min(at, now()) - since)
    running = false
  }

  const pause = () => pauseAt(now())
  const pauseForIdle = () => pauseAt(lastActivity + IDLE_MS)
  const idle = () => now() - lastActivity >= IDLE_MS

  const resume = () => {
    if (running) return
    since = now()
    running = true
  }

  const onActivity = () => {
    lastActivity = now()
    if (visible()) resume()
  }

  const onVisibility = () => {
    if (visible()) onActivity()
    else pause()
  }

  const timer = setInterval(() => {
    if (running && idle()) pauseForIdle()
  }, 5_000)

  for (const event of ACTIVITY) globalThis.addEventListener?.(event, onActivity, { passive: true })
  globalThis.document?.addEventListener('visibilitychange', onVisibility)

  return {
    elapsed() {
      // Checked at read as well as on the interval: a card answered between two
      // ticks must not be credited the gap it sat through.
      if (running && idle()) pauseForIdle()
      return running ? accumulated + (now() - since) : accumulated
    },
    stop() {
      pause()
      clearInterval(timer)
      for (const event of ACTIVITY) globalThis.removeEventListener?.(event, onActivity)
      globalThis.document?.removeEventListener('visibilitychange', onVisibility)
    },
  }
}

/** True when there is no document at all (tests, a worker) — then always count. */
const visible = () => globalThis.document?.visibilityState !== 'hidden'
