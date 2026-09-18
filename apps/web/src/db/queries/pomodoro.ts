import { db } from '../client.ts'

/**
 * Focus blocks, logged beside reviews.
 *
 * The timer is not the point. `reviews.ts` and `pomodoro_sessions.started_at`
 * are the same clock, so "how accurate was I in the twenty-five minutes after I
 * sat down" is a join rather than a feeling — that is the only reason this
 * table exists rather than a number in localStorage.
 *
 * The row is written when the block *starts*, not when it finishes: a reload or
 * a closed laptop must not lose the block, and `ended_at IS NULL` is what makes
 * a running timer recoverable.
 *
 * (The relative import is deliberate: `usePomodoro.ts` is loaded directly by
 * `node --test` and node resolves no tsconfig path alias.)
 */

export type PomodoroKind = 'focus' | 'break'

export interface PomodoroSession {
  id: string
  deck_id: string | null
  kind: PomodoroKind
  started_at: number
  ended_at: number | null
  planned_ms: number
}

/** 25/5. Not configurable yet — ponytail: two constants until someone asks. */
export const PLANNED: Record<PomodoroKind, number> = {
  focus: 25 * 60_000,
  break: 5 * 60_000,
}

/** The block still running, if any. */
export async function openSession(): Promise<PomodoroSession | null> {
  const [row] = await db.select<PomodoroSession>(
    'SELECT * FROM pomodoro_sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1',
  )
  return row ?? null
}

export async function startSession(
  kind: PomodoroKind,
  deckId: string | null,
  now = Date.now(),
): Promise<PomodoroSession> {
  const session: PomodoroSession = {
    id: crypto.randomUUID(),
    deck_id: deckId,
    kind,
    started_at: now,
    ended_at: null,
    planned_ms: PLANNED[kind],
  }
  await db.batch([
    // A second tab, or a tab closed mid-block, leaves a row open forever and
    // every later `openSession` resurrects it. Close any stragglers at the end
    // they were planned for — never at "now", which would log a block hours
    // long that nobody sat through.
    {
      sql: `UPDATE pomodoro_sessions SET ended_at = MIN(?, started_at + planned_ms)
             WHERE ended_at IS NULL`,
      params: [now],
    },
    {
      sql: `INSERT INTO pomodoro_sessions (id, deck_id, kind, started_at, ended_at, planned_ms)
            VALUES (?,?,?,?,NULL,?)`,
      params: [session.id, session.deck_id, session.kind, session.started_at, session.planned_ms],
    },
  ])
  return session
}

export const endSession = (id: string, endedAt: number) =>
  db.run('UPDATE pomodoro_sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL', [
    endedAt,
    id,
  ])

export interface FocusBlock extends PomodoroSession {
  reviews: number
  /** Anything but Again. The same definition the dashboard uses. */
  correct: number
}

/**
 * Focus blocks since `since`, each carrying the reviews that fell inside it.
 *
 * Correlating by timestamp rather than by a `pomodoro_id` column on `reviews`:
 * `reviews` is append-only and already written by the study loop, and a review
 * is inside a block or it is not — the clock already knows, and stamping it
 * would mean two writers agreeing about one fact.
 */
export const focusBlocks = (since: number, now = Date.now()) =>
  db.select<FocusBlock>(
    `SELECT p.*,
            (SELECT COUNT(*) FROM reviews r
              WHERE r.ts >= p.started_at AND r.ts < COALESCE(p.ended_at, ?)) AS reviews,
            (SELECT COUNT(*) FROM reviews r
              WHERE r.ts >= p.started_at AND r.ts < COALESCE(p.ended_at, ?)
                AND r.rating > 1) AS correct
       FROM pomodoro_sessions p
      WHERE p.kind = 'focus' AND p.started_at >= ?
      ORDER BY p.started_at DESC`,
    [now, now, since],
  )
