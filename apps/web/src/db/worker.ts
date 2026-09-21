/// <reference lib="webworker" />
import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { MIGRATIONS } from '@recall/core'

/**
 * One dedicated worker per tab; exactly one of them owns the database.
 *
 * Why not a SharedWorker (as PLAN.md originally said): OPFS
 * `createSyncAccessHandle` is `[Exposed=DedicatedWorker]`, so sqlite-wasm's
 * opfs-sahpool VFS cannot run in a SharedWorker at all, and Chrome does not
 * allow a SharedWorker to nest a dedicated one. Verified both in-browser.
 *
 * So: every tab's worker queues on the same Web Lock. The holder opens the DB
 * and serves the other tabs over a BroadcastChannel. When the leader's tab
 * closes, the lock releases and the next waiter takes over automatically.
 */

type Req = {
  id: number
  method: 'select' | 'run' | 'batch' | 'attach' | 'attachSelect' | 'detach' | 'build'
  sql?: string
  params?: unknown[]
  batch?: { sql: string; params?: unknown[] }[]
  bytes?: Uint8Array
}
type Result =
  | { ok: true; rows?: unknown[]; bytes?: Uint8Array }
  | { ok: false; error: string }

/** Methods that work on a scratch database rather than the collection. */
const SCRATCH = new Set(['attach', 'attachSelect', 'detach', 'build'])

const LOCK = 'recall-db-owner'
const CHANNEL = 'recall-db'

let database: any = null
let isLeader = false
let openError: string | null = null
const bus = new BroadcastChannel(CHANNEL)

/** Recent replies, so a retried request is answered rather than re-run. Map
 *  keeps insertion order, which is all the eviction policy this needs. */
const REPLIES_KEPT = 200
const answered = new Map<string, Result>()

/**
 * The wasm module, shared by the collection and by the scratch databases an
 * import or an export needs. Started once per worker, by whoever asks first —
 * a tab that lost the leader election still has to be able to read an `.apkg`.
 */
let modulePromise: Promise<any> | null = null
const sqliteModule = () =>
  (modulePromise ??= sqlite3InitModule({ print: () => {}, printErr: console.error }))

/**
 * `REGEXP`, which SQLite leaves to the host.
 *
 * It has to be a SQL function rather than a filter applied to the results,
 * because of rule 4: the header count, the page and the rows a bulk operation
 * touches are three separate queries over the same WHERE clause, and a filter
 * that only one of them applies would make the count a lie.
 *
 * Case-insensitive, matching how every other text search here behaves. A
 * pattern that does not compile matches nothing — `parseSearch` has already
 * rejected those, so this is only the last line.
 */
function registerRegexp(db: { createFunction: (...args: unknown[]) => unknown }): void {
  const cache = new Map<string, RegExp | null>()
  db.createFunction('regexp', (_ctx: unknown, pattern: unknown, value: unknown) => {
    if (typeof pattern !== 'string' || value == null) return 0
    if (!cache.has(pattern)) {
      try {
        cache.set(pattern, new RegExp(pattern, 'i'))
      } catch {
        cache.set(pattern, null)
      }
    }
    const re = cache.get(pattern)
    return re && re.test(String(value)) ? 1 : 0
  })
}

async function open() {
  const sqlite3 = await sqliteModule()
  // opfs-sahpool: fastest OPFS backend, and unlike the plain "opfs" VFS it needs
  // no COOP/COEP headers — which would otherwise block CDN assets and embeds.
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'recall' })
  const db = new pool.OpfsSAHPoolDb('/recall.sqlite3')
  db.exec('PRAGMA foreign_keys = ON')
  registerRegexp(db)
  const current = Number(db.selectValue('PRAGMA user_version') ?? 0)
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]!)
      db.exec(`PRAGMA user_version = ${i + 1}`)
    })
  }
  return db
}

function run(req: Req): Result {
  const d = database
  try {
    if (req.method === 'select') {
      return {
        ok: true,
        rows: d.exec({
          sql: req.sql!,
          bind: req.params ?? [],
          rowMode: 'object',
          returnValue: 'resultRows',
        }),
      }
    }
    if (req.method === 'run') {
      d.exec({ sql: req.sql!, bind: req.params ?? [] })
      return { ok: true }
    }
    d.transaction(() => {
      for (const s of req.batch ?? []) d.exec({ sql: s.sql, bind: s.params ?? [] })
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Scratch databases: the foreign collection inside an `.apkg`, and the one an
 * export is assembled into.
 *
 * Deliberately **not** routed through the Web Lock. Neither is the user's
 * collection — one is a file they just picked, the other is bytes on their way
 * to a download — so a second tab has no business seeing either, and making the
 * leader do this work would serialise a long import behind every review.
 *
 * `sqlite3_js_posix_create_file` drops the bytes into the wasm build's own
 * in-memory filesystem, which is what lets sqlite open a database it did not
 * create. It costs one copy of the file in the wasm heap; a 20k-card
 * collection is tens of megabytes, and it is freed on detach.
 */
const IMPORT_PATH = '/import.anki'
let attached: any = null

async function scratch(req: Req): Promise<Result> {
  const sqlite3 = await sqliteModule()
  try {
    if (req.method === 'attach') {
      attached?.close()
      attached = null
      sqlite3.capi.sqlite3_js_posix_create_file(IMPORT_PATH, req.bytes!)
      attached = new sqlite3.oo1.DB(IMPORT_PATH, 'r')
      return { ok: true }
    }
    if (req.method === 'attachSelect') {
      if (!attached) return { ok: false, error: 'No collection attached' }
      return {
        ok: true,
        rows: attached.exec({
          sql: req.sql!, bind: req.params ?? [], rowMode: 'object', returnValue: 'resultRows',
        }),
      }
    }
    if (req.method === 'detach') {
      attached?.close()
      attached = null
      return { ok: true }
    }
    // build: assemble a database in memory and hand back its bytes.
    const out = new sqlite3.oo1.DB()
    try {
      out.transaction(() => {
        for (const st of req.batch ?? []) out.exec({ sql: st.sql, bind: st.params ?? [] })
      })
      return { ok: true, bytes: sqlite3.capi.sqlite3_js_db_export(out.pointer) }
    } finally {
      out.close()
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Queue for this lock. The callback holds the lock for the tab's lifetime.
void navigator.locks.request(LOCK, async () => {
  try {
    database = await open()
  } catch (e) {
    // Release the lock so another tab can try, and remember why we failed.
    openError = e instanceof Error ? e.message : String(e)
    return
  }
  isLeader = true
  bus.onmessage = (e) => {
    const { kind, token, req } = e.data ?? {}
    if (kind !== 'req') return
    // Answers are cached by token because a follower re-posts a request it has
    // not heard back from yet (see `dispatch`). Without this, a slow write
    // would be *executed twice* — and one of the things it writes is the
    // append-only review log.
    let result = answered.get(token)
    if (!result) {
      result = run(req)
      answered.set(token, result)
      if (answered.size > REPLIES_KEPT)
        for (const k of [...answered.keys()].slice(0, answered.size - REPLIES_KEPT))
          answered.delete(k)
    }
    bus.postMessage({ kind: 'res', token, result })
  }
  await new Promise<never>(() => {}) // hold until this tab goes away
})

/**
 * Resolve a request against whichever worker owns the database.
 *
 * Note a BroadcastChannel never delivers a message back to the context that
 * posted it, so this must re-check `isLeader` on every retry: the very first
 * request usually arrives before this worker has finished winning the lock,
 * and it would otherwise broadcast into a void that only it could answer.
 */
function dispatch(req: Req): Promise<Result> {
  return new Promise((resolve) => {
    const token = `${Math.random()}`
    let settled = false
    const done = (r: Result) => {
      settled = true
      bus.removeEventListener('message', listener)
      resolve(r)
    }
    const listener = (e: MessageEvent) => {
      if (e.data?.kind !== 'res' || e.data.token !== token) return
      done(e.data.result)
    }
    bus.addEventListener('message', listener)

    let attempts = 0
    const attempt = () => {
      if (settled) return
      if (isLeader) return done(run(req))
      // Failing to open the database ourselves is not the same as there being
      // no database: another tab may well own it. Keep asking, and only report
      // our own failure once nobody has answered at all.
      if (attempts++ > 40)
        return done({ ok: false, error: openError ?? 'No database owner responded' })
      bus.postMessage({ kind: 'req', token, req })
      setTimeout(attempt, 100)
    }
    attempt()
  })
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const req = e.data
  const result = SCRATCH.has(req.method) ? await scratch(req) : await dispatch(req)
  self.postMessage({ id: req.id, ...result })
}
