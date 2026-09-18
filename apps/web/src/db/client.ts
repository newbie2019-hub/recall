type Pending = { resolve: (v: any) => void; reject: (e: Error) => void }

const pending = new Map<number, Pending>()
let seq = 0
let worker: Worker | null = null

function connect() {
  if (worker) return worker
  // The `new URL(...)` must stay inline — Vite only emits a worker chunk from
  // the literal form, not from a hoisted variable.
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent<any>) => {
    const p = pending.get(e.data.id)
    if (!p) return
    pending.delete(e.data.id)
    e.data.ok ? p.resolve(e.data.bytes ?? e.data.rows ?? []) : p.reject(new Error(e.data.error))
  }
  worker.onerror = (e) => {
    for (const [, p] of pending) p.reject(new Error(e.message || 'Database worker failed'))
    pending.clear()
    // Drop the dead worker. Keeping it cached would leave every later call
    // waiting on a postMessage nothing is listening to — the app would hang
    // silently instead of showing the "can't open your collection" screen.
    worker = null
  }
  return worker
}

function call<T>(msg: Record<string, unknown>): Promise<T> {
  const w = connect()
  const id = ++seq
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    w.postMessage({ ...msg, id })
  })
}

export const db = {
  select: <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    call<T[]>({ method: 'select', sql, params }),
  run: (sql: string, params: unknown[] = []) => call<void>({ method: 'run', sql, params }),
  batch: (batch: { sql: string; params?: unknown[] }[]) => call<void>({ method: 'batch', batch }),

  /**
   * A second, throwaway database in the same worker — the collection inside an
   * `.apkg` on the way in, and the one we assemble on the way out. It never
   * touches the user's collection, so it skips the cross-tab lock entirely.
   */
  attach: (bytes: Uint8Array) => call<void>({ method: 'attach', bytes }),
  attachSelect: <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    call<T[]>({ method: 'attachSelect', sql, params }),
  detach: () => call<void>({ method: 'detach' }),
  build: (batch: { sql: string; params?: unknown[] }[]) =>
    call<Uint8Array>({ method: 'build', batch }),
}
