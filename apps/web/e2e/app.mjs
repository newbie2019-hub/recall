/**
 * Browser check for the whole app. Drives real Chrome over the DevTools
 * Protocol — the only way to exercise OPFS, which does not exist in jsdom or
 * Node, and the only way to see inside the sandboxed card frames. No test
 * framework on purpose.
 *
 *   pnpm build && pnpm exec vite preview --port 4173 &
 *   node e2e/app.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const URL_UNDER_TEST = process.env.URL ?? 'http://localhost:4173/'
/** A 200x200 flat PNG, inline so the suite carries no binary fixture. */
const PLATE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAMgAAADICAIAAAAiOjnJAAABeElEQVR42u3SMQ0AAAgEsffvjZUJMZhgYGhSBZfLdMG5SICxMBbGAmNhLIwFxsJYGAuMhbEwFhgLY2EsMBbGwlhgLIyFscBYGAtjgbEwFsYCY2EsjAXGwlgYC4yFsTAWGAtjYSwwFsbCWGAsjIWxwFgYC2OBsTAWxgJjYSyMBcbCWBgLjIWxMBYYC2NhLDAWxsJYYCyMhbHAWBgLY4GxMBbGAmNhLIwFxsJYGAuMhbEwFhgLY2EsjKUCxsJYGAuMhbEwFhgLY2EsMBbGwlhgLIyFscBYGAtjgbEwFsYCY2EsjAXGwlgYC4yFsTAWGAtjYSwwFsbCWGAsjIWxwFgYC2OBsTAWxgJjYSyMBcbCWBgLjIWxMBYYC2NhLDAWxsJYYCyMhbHAWBgLY4GxMBbGAmNhLIwFxsJYGAuMhbEwFhgLY2EsMBbGwlgYSwWMhbEwFhgLY2EsMBbGwlhgLIyFscBYGAtjgbEwFsYCY2EsjAXGwlgYC4zFNwuNzxqb3CQjoQAAAABJRU5ErkJggg=='
const CHROME =
  process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

// A fresh port per run: a previous Chrome can still hold 9222 for a second or
// two after being killed, and connecting to it silently tests the wrong page.
const PORT = 9222 + (process.pid % 400)
const profile = mkdtempSync(join(tmpdir(), 'recall-e2e-'))
const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-first-run',
   // The renderer was crashing part-way through this suite. Shared memory is
   // the usual culprit for a headless tab doing wasm SQLite over OPFS.
   '--disable-dev-shm-usage',
   `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, 'about:blank'],
  { stdio: 'ignore' },
)
const cleanup = () => {
  chrome.kill()
  // Chrome may still be flushing the profile; it is a temp dir either way, so
  // never let cleanup failure mask the test result.
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
}
process.on('exit', cleanup)

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const ok = (cond, msg) => { if (!cond) failures++; console.log(`${cond ? 'ok  ' : 'FAIL'}  ${msg}`) }
const section = (name) => console.log(`\n# ${name}`)

let targets
for (let i = 0; i < 60; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); if (targets.length) break } catch {}
  await wait(250)
}
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))

let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  if (m.method === 'Runtime.exceptionThrown')
    console.log('[page error]', m.params.exceptionDetails.exception?.description?.split('\n')[0])
  // A crashed renderer answers nothing and looks exactly like a slow page, so
  // say so out loud rather than letting it read as a failed assertion.
  if (m.method === 'Inspector.targetCrashed') console.log('[RENDERER CRASHED]')
  if (m.method === 'Runtime.executionContextsCleared') console.log('[context cleared]')
  // A toast is how this app reports a failed write, and toasts vanish after a
  // few seconds — long before a `until` gives up and photographs the page. So
  // keep the last few console lines and print them with the timeout: without
  // them, "the clone did not open" is indistinguishable from "the clone threw".
  if (m.method === 'Runtime.consoleAPICalled') {
    const text = m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')
    recent.push(`${m.params.type}: ${text.split('\n')[0]}`)
    if (recent.length > 8) recent.shift()
  }
})
const recent = []
/**
 * A DevTools call, with a deadline.
 *
 * Without one, a reply that never arrives — a crashed target, a navigation that
 * ate the message — hangs the whole suite silently and forever, which is how a
 * ten-minute "still running" turns out to be a dead process nobody noticed.
 */
const send = (method, params = {}, timeoutMs = 20_000) =>
  new Promise((res, rej) => {
    const i = ++id
    const timer = setTimeout(
      () => { pending.delete(i); rej(new Error(`DevTools ${method} did not answer in ${timeoutMs}ms`)) },
      timeoutMs,
    )
    pending.set(i, (m) => { clearTimeout(timer); res(m) })
    ws.send(JSON.stringify({ id: i, method, params }))
  })
/**
 * Evaluate in the page, tolerating a lost reply.
 *
 * `Page.navigate` destroys the execution context, and an evaluate already in
 * flight when that happens is simply never answered — no error, no reply. With
 * one shared deadline that silently hung the entire suite; with a short one it
 * becomes a missed poll, which is what every caller here is already built to
 * survive because `until` loops anyway.
 */
const ev = async (expr) => {
  try {
    const reply = await send(
      'Runtime.evaluate',
      { expression: expr, awaitPromise: true, returnByValue: true },
      5_000,
    )
    return reply.result?.result?.value
  } catch {
    return undefined
  }
}
/**
 * Wait for an element, then click it.
 *
 * The bug this exists to stop: a screen's heading renders immediately and its
 * list renders one async hop later, so `until('…heading…')` can pass while the
 * buttons are still absent. A click at that moment finds nothing, throws a
 * TypeError inside `ev`, and `ev` swallows it — leaving a ten-second wait for
 * something that was never asked for, and a timeout that blames the wrong step.
 * Waiting on the *thing being clicked* is the fix; the throw is the safety net.
 */
const clickSelector = async (selector, label) => {
  await until(`!!document.querySelector(${JSON.stringify(selector)})`, label ?? selector)
  const hit = await ev(
    `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;el.click();return true})()`,
  )
  if (!hit) throw new Error(`${label ?? selector} vanished between waiting for it and clicking it`)
}

const until = async (expr, label, tries = 60) => {
  for (let i = 0; i < tries; i++) { if (await ev(expr)) return; await wait(250) }
  // A timeout that only says which label it was waiting for makes you re-run the
  // suite to find out what the page was actually showing. Say it now.
  const where = await ev('location.pathname').catch(() => '?')
  const seen = (await ev('document.body.innerText').catch(() => '')) ?? ''
  throw new Error(
    `timed out waiting for ${label}\n  at ${where}\n  page showed: ${JSON.stringify(seen.slice(0, 400))}`
    + (recent.length ? `\n  console: ${recent.join('\n           ')}` : ''),
  )
}
/**
 * Like `until`, but reports instead of throwing — for asserting a thing that
 * is true *eventually*. Card frames repaint one async hop after the page text
 * that announces them, so reading them the instant the text lands is a race.
 */
const eventually = async (expr) => {
  for (let i = 0; i < 40; i++) { if (await ev(expr)) return true; await wait(250) }
  return false
}
const inFrames = (needle, prop = 'innerHTML') =>
  eventually(`[...document.querySelectorAll('iframe')]
     .some(f => (f.contentDocument?.body?.${prop} || '').includes(${JSON.stringify(needle)}))`)

const text = () => ev('document.body.innerText')
// Card content lives inside sandboxed iframes, so page text alone sees nothing.
const frames = (prop = 'innerText') =>
  ev(`[...document.querySelectorAll('iframe')].map(f=>f.contentDocument?.body?.${prop}||'').join('\\n~~\\n')`)
const counter = () => ev(`document.querySelector('header span')?.textContent`)
const click = (label) =>
  ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${JSON.stringify(label)}));if(b){b.click();return true}return false})()`)
const key = (k) => ev(`(window.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)}})),true)`)
const focusField = (n) =>
  ev(`(()=>{const f=document.querySelectorAll('[role=textbox]')[${n}];if(!f)return false;f.focus();return true})()`)
const type = (t) => send('Input.insertText', { text: t })
const clearField = () =>
  ev(`(document.execCommand('selectAll'),document.execCommand('delete'),true)`)
// Saving is async and returns to the deck browser; navigating before it lands
// would abort the write mid-flight. `Add note` deliberately does NOT return —
// it stays put so twenty cards are one screen — so adding uses "Add and close".
const save = async (label) => {
  await click(label)
  await until(`document.body.innerText.includes('New note')`, 'back in the browser')
}

await send('Runtime.enable')
await send('Inspector.enable')
await send('Page.enable')
await send('DOM.enable')

/**
 * Sign the browser in before the first byte of the app runs.
 *
 * The app requires an account now, and every `Page.navigate` below would
 * otherwise land on `/sign-in`. Rather than drive the sign-up form ten times,
 * seed what a signed-in browser actually holds: a token and the last user the
 * server confirmed.
 *
 * This is not a bypass — it is the offline path, tested. `RequireAuth`
 * deliberately does not ask the server who you are; it trusts a session this
 * browser has already held, so that a dead network cannot lock somebody out of
 * their own cards. With no API running at all, that is exactly the state below,
 * and the suite passing is the assertion that the rule holds.
 */
const SESSION = {
  'recall.token': 'e2e-token-never-sent-anywhere',
  'recall.user': JSON.stringify({
    id: '00000000-0000-4000-8000-000000000000',
    name: 'E2E Runner',
    email: 'e2e@example.invalid',
    email_verified: true,
    is_moderator: false,
    onboarded: true,
  }),
}
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try{${Object.entries(SESSION)
    .map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)},${JSON.stringify(v)})`)
    .join(';')}}catch{}`,
})

await send('Page.navigate', { url: URL_UNDER_TEST })

// ── deck tree ──────────────────────────────────────────────────────────────
section('decks')
await until(`document.body.innerText.includes('Study now')`, 'deck list')
const deckList = await text()
// Siblings sort by name, children follow their parent: the CTE orders by path.
ok(/Anatomy[\s\S]*Neuroanatomy[\s\S]*Thorax[\s\S]*Heart[\s\S]*Pharmacology/.test(deckList),
   'nested decks render in tree order')

const newOf = (deck) =>
  ev(`(()=>{const li=[...document.querySelectorAll('li')].find(x=>x.textContent.trim().startsWith(${JSON.stringify(deck)}));
      const m=li&&li.textContent.match(/(\\d+) new/);return m?+m[1]:0})()`)
/** Read until two reads agree — the deck list repaints once its query lands. */
const stable = async (read) => {
  let a = await read()
  for (let i = 0; i < 10; i++) {
    await wait(300)
    const b = await read()
    if (b === a) return b
    a = b
  }
  return a
}

const [anatomy, thorax, heart, neuro] =
  await Promise.all([newOf('Anatomy'), newOf('Thorax'), newOf('Heart'), newOf('Neuroanatomy')])
ok(heart > 0 && thorax > heart, 'a parent deck rolls up its children')
ok(anatomy === thorax + neuro, 'roll-up sums the whole subtree, once')

// ── study loop ─────────────────────────────────────────────────────────────
section('study')
await click('Study now')
await until(`document.querySelectorAll('iframe').length === 2`, 'review screen')

const sandbox = await ev(`document.querySelector('iframe').getAttribute('sandbox')`)
ok(sandbox === 'allow-same-origin', 'card frame is sandboxed with scripts off')
const noScript = await ev(
  `(()=>{const d=document.querySelector('iframe').contentDocument;
     return !!d.querySelector('meta[http-equiv="Content-Security-Policy"]')})()`)
ok(noScript, 'card frame carries a content security policy')

await until(`document.querySelector('iframe').contentDocument.body.innerText.trim().length > 0`, 'front rendered')
ok((await frames()).trim().length > 0, 'card content renders inside the frame')

// 20 cards exist across the seed; Neuroanatomy's daily limit holds 2 of them
// back, and the counter is meant to show the session, not the collection.
const total = Number((await counter()).split('/')[1])
ok(total === 18, `the counter shows today's session, not every card (${total}/18)`)

await key(' ')
await until(`document.body.innerText.includes('Again')`, 'reveal')
const body = await text()
ok(['Again', 'Hard', 'Good', 'Easy'].every((l) => body.includes(l)), 'four answer buttons on reveal')
ok(/\d+(\.\d+)?(m|h|d|mo|y)\b/.test(body), 'each button shows its predicted interval')

const before = await counter()
await key('3')
await until(`document.querySelector('header span').textContent !== ${JSON.stringify(before)}`, 'next card')
ok((await counter()) === `1/${total}`, 'rating advances the session counter')

// The point of the whole exercise: it survives a reload, from OPFS.
await send('Page.navigate', { url: URL_UNDER_TEST })
await until(`document.body.innerText.includes('Study now')`, 'reload')
await click('Study now')
await until(`!!document.querySelector('header span')`, 'review after reload')
ok((await counter()) === `1/${total}`, 'review persisted across reload')

await key(' ')
await wait(300)
await key('1')
await until(`document.querySelector('header span').textContent === '2/${total}'`, 'second review')
await key('u')
await until(`document.querySelector('header span').textContent === '1/${total}'`, 'undo')
ok(true, 'undo drops the unsynced review and replays the log')

// ── rendering: cloze, maths, type-in ───────────────────────────────────────
section('rendering')
const openNote = async (deck, needle) => {
  await send('Page.navigate', { url: URL_UNDER_TEST })
  await until(`document.body.innerText.includes('Study now')`, 'deck list')
  await click(deck)
  // The deck's own chrome paints before its notes query lands, so wait for the
  // row itself rather than for the screen around it.
  await until(
    `[...document.querySelectorAll('li button')].some(x=>x.textContent.includes(${JSON.stringify(needle)}))`,
    `note "${needle}"`,
  )
  await ev(`(()=>{const b=[...document.querySelectorAll('li button')].find(x=>x.textContent.includes(${JSON.stringify(needle)}));b.click();return true})()`)
  await until(`document.body.innerText.toUpperCase().includes('PREVIEW')`, 'editor')
  await until(`document.querySelectorAll('iframe').length === 2`, 'preview frames')
  await wait(250)
}

await openNote('Heart', 'sinoatrial node')
ok(await inFrames('[...]') && await inFrames('cloze-blank'), 'cloze front blanks the deletion')
ok(await inFrames('class="cloze"'), 'cloze back highlights the answer')
ok((await text()).includes('2 cards'), 'one card per distinct deletion')

await openNote('Heart', 'cardiac output')
ok(await inFrames('katex'), 'LaTeX renders through KaTeX inside the frame')
ok(await inFrames('katex-display'), 'display maths is recognised as display maths')

await openNote('Heart', 'Stroke volume')
ok(await inFrames('[a subtraction]', 'innerText'), 'a cloze hint replaces the ellipsis')

// ── authoring ──────────────────────────────────────────────────────────────
section('authoring')
await send('Page.navigate', { url: URL_UNDER_TEST })
await until(`document.body.innerText.includes('Study now')`, 'deck list')
await click('Pharmacology')
await until(`document.querySelectorAll('li button').length > 0`, 'browser')
const notesBefore = await ev(`document.querySelectorAll('li button').length`)

await click('New note')
await until(`document.body.innerText.toUpperCase().includes('PREVIEW')`, 'editor')
ok((await text()).includes('No cards yet'), 'an empty note generates nothing')

await focusField(0)
await type('What is the volume of distribution?')
await focusField(1)
await type('Dose divided by plasma concentration.')
await until(`document.body.innerText.includes('1 card')`, 'generation')
ok(await inFrames('volume of distribution', 'innerText'), 'the preview renders what was typed')

await save('Add and close')
await until(`document.querySelectorAll('li button').length === ${notesBefore + 1}`, 'saved')
ok(true, 'a new note round-trips to the deck browser')

// ── the generation rule ────────────────────────────────────────────────────
section('card generation')
await openNote('Pharmacology', 'loading dose')
ok((await text()).includes('2 cards'), 'optional reverse starts with two cards')

await focusField(2)
await clearField()
await until(`document.body.innerText.includes('1 card')`, 'card 2 withdrawn')
ok(true, 'emptying the conditional field stops generating card 2')
await save('Save note')

await openNote('Pharmacology', 'loading dose')
ok((await text()).includes('1 card'), 'the withdrawn card stayed withdrawn across a reload')

await focusField(2)
await type('y')
await until(`document.body.innerText.includes('2 cards')`, 'card 2 back')
await save('Save note')
await openNote('Pharmacology', 'loading dose')
ok((await text()).includes('2 cards'), 'refilling the field brings card 2 back')

// ── image occlusion ────────────────────────────────────────────────────────
// The one kind you draw rather than type, so it is the one kind a unit test
// cannot reach: it needs a real file input, a real image decode and real
// pointer events.
section('image occlusion')
const plate = join(tmpdir(), 'recall-plate.png')
writeFileSync(plate, Buffer.from(PLATE_PNG, 'base64'))

await send('Page.navigate', { url: URL_UNDER_TEST })
await until(`document.body.innerText.includes('Study now')`, 'deck list')
await click('Thorax')
await until(`document.querySelectorAll('li button').length > 0`, 'browser')
await click('New note')
await until(`document.body.innerText.toUpperCase().includes('PREVIEW')`, 'editor')

await ev(`document.querySelectorAll('button[role=combobox]')[0].click()`)
await until(`[...document.querySelectorAll('[role=option]')].some(o=>o.textContent.includes('Image Occlusion'))`, 'type list')
await ev(`[...document.querySelectorAll('[role=option]')].find(o=>o.textContent.includes('Image Occlusion')).click()`)
await until(`document.body.innerText.includes('Choose an image')`, 'occlusion editor')

const doc = await send('DOM.getDocument', { depth: 1 })
const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: 'input[type=file]' })
await send('DOM.setFileInputFiles', { files: [plate], nodeId: input.result.nodeId })
await until(`!!document.querySelector('img[src^="blob:"]')`, 'image stored')
ok(true, 'the chosen image is hashed into the media store and read back out')

// The element exists the moment its `src` is set, but its *box* does not until
// the bytes decode. Measuring too early gives a rect a few pixels tall, and the
// drag below then lands outside the image and draws nothing.
await until(
  `(() => { const i = document.querySelector('img[src^="blob:"]')
     return !!i && i.complete && i.naturalWidth > 0 && i.getBoundingClientRect().height > 50 })()`,
  'image decoded and laid out',
)

const rect = JSON.parse(await ev(
  `(()=>{const r=document.querySelector('img[src^="blob:"]').getBoundingClientRect();
     return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height})})()`))
const at = (fx, fy) => ({ x: Math.round(rect.x + rect.w * fx), y: Math.round(rect.y + rect.h * fy) })
const drag = async (from, to) => {
  // The leading move matters: a synthetic press with no prior motion can land
  // inside React's commit for the previous mask.
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'none', ...at(...from) })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...at(...from) })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, ...at(...to) })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...at(...to) })
}

/**
 * One retry, because the *first* drag is the flaky one.
 *
 * The editor binds its pointer handlers in an effect that runs after the image
 * has decoded, and a synthetic press dispatched in the gap between those two
 * moments is delivered to an element that is not listening yet — no mask, no
 * error, roughly one run in five. Every later drag lands, which is what says
 * this is a startup race rather than a broken interaction. Waiting on the
 * handler itself would mean exposing it to the page; dragging twice costs four
 * CDP calls.
 */
await drag([0.15, 0.15], [0.55, 0.5])
if (!(await ev(`document.body.innerText.includes('1 card')`))) {
  await drag([0.15, 0.15], [0.55, 0.5])
}
await until(`document.body.innerText.includes('1 card')`, 'first mask')
ok(true, 'dragging on the image draws a mask, and the mask is a card')

ok(await inFrames('io-asked'), 'the front masks the region being asked about')
ok(await inFrames('io-revealed'), 'the back uncovers it')
ok(await inFrames('blob:'), 'the image resolves to live bytes inside the sandboxed frame')

await wait(300)
await drag([0.6, 0.6], [0.85, 0.85])
await until(`document.body.innerText.includes('2 cards')`, 'second mask')
await save('Add and close')
ok(true, 'a second mask adds a second card, and the note saves with both')

// ── the payoff: a card that comes back brings its history ──────────────────
// Card ids are `<note id>:<ord>`, so a regenerated card finds its own rows in
// the append-only log and replays them. If that failed, the restored card would
// come back as new, and Pharmacology's new count would tick up.
section('history survives regeneration')
await send('Page.navigate', { url: URL_UNDER_TEST })
await until(`document.body.innerText.includes('Study now')`, 'deck list')
await click('Pharmacology')
await until(`document.querySelectorAll('li button').length > 0`, 'browser')
await click('Study')
await until(`!!document.querySelector('header span')`, 'review')
// Rate every card in the deck. Each step waits for the state it needs rather
// than sleeping, so a slow paint cannot swallow a keystroke and leave a card
// unreviewed — which would quietly make the assertion below meaningless.
for (let i = 0; i < 8; i++) {
  if (await ev(`document.body.innerText.includes('Nothing due')`)) break
  const at = await counter()
  await until(`document.querySelector('iframe')?.contentDocument?.body?.innerText.trim().length > 0`, 'card painted')
  await key('Enter')
  await until(`document.body.innerText.includes('Again')`, 'reveal')
  await key('3')
  await until(
    `document.body.innerText.includes('Nothing due') ||
     document.querySelector('header span')?.textContent !== ${JSON.stringify(at)}`,
    'next card',
  )
}
await click('Back to decks')
await until(`document.body.innerText.includes('Study now')`, 'deck list')
ok((await stable(() => newOf('Pharmacology'))) === 0, 'studying the deck leaves it with no new cards')

await openNote('Pharmacology', 'loading dose')
await focusField(2)
await clearField()
await until(`document.body.innerText.includes('1 card')`, 'withdrawn')
await save('Save note')
await openNote('Pharmacology', 'loading dose')
await focusField(2)
await type('y')
await until(`document.body.innerText.includes('2 cards')`, 'restored')
await save('Save note')

await send('Page.navigate', { url: URL_UNDER_TEST })
await until(`document.body.innerText.includes('Study now')`, 'deck list')
ok((await stable(() => newOf('Pharmacology'))) === 0, 'the restored card kept its schedule instead of starting over')

// ── the daily new-card limit ───────────────────────────────────────────────
// Without this, importing a 20k-card deck means being offered 20k cards on day
// one. The badge, the study loop and the browser all have to agree about it.
section('daily new limit')

ok((await stable(() => newOf('Neuroanatomy'))) === 2,
   'the deck offers its daily allowance, not everything it holds')

await click('Neuroanatomy')
await until(`document.body.innerText.includes('New note')`, 'browser')
const neuroCards = await ev(
  `[...document.querySelectorAll('li')].reduce((n,li)=>{
     const m=li.textContent.match(/(\\d+) cards?$/);return n+(m?+m[1]:0)},0)`)
ok(neuroCards > 2, `the held-back cards still exist (${neuroCards} in the deck)`)

// The limit is editable, and editing it moves the badge — Phase 1's deck
// options, which had no UI until they were checked for.
await ev(`(()=>{const i=document.getElementById('new-per-day');
  // React tracks the input's value on the node, so the native setter has to be
  // the one that changes it or the change event is treated as a no-op.
  const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
  set.call(i,'3');i.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
await wait(400)
await click('All decks')
await until(`document.body.innerText.includes('Study now')`, 'deck list')
ok((await stable(() => newOf('Neuroanatomy'))) === 3, 'raising the limit offers one more card')

await click('Neuroanatomy')
await until(`document.body.innerText.includes('New note')`, 'browser')
await click('Study')
await until(`document.querySelectorAll('iframe').length === 2`, 'review screen')
for (let i = 0; i < 3; i++) {
  await key(' ')
  await until(`document.body.innerText.includes('Again')`, `reveal ${i + 1}`)
  await key('3')
  await wait(400)
}

await until(`document.body.innerText.includes('Nothing due')`, 'allowance spent')
ok(true, 'the deck stops introducing once the allowance is spent')

// ── Phase 3: decks you can actually make ───────────────────────────────────
section('deck management')
await send('Page.navigate', { url: URL_UNDER_TEST })
await until(`document.body.innerText.includes('Study now')`, 'deck list')

const deckNames = () =>
  ev(`[...document.querySelectorAll('main li, ul li')]
       .map(li=>li.textContent.trim().split('\\n')[0]).join('|')`)
const setInput = (id, value) => ev(`(()=>{const i=document.getElementById(${JSON.stringify(id)});
  if(!i)return false;
  const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
  set.call(i,${JSON.stringify(value)});i.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
// Radix menus open on pointerdown, not click.
const openMenu = (label) => ev(`(()=>{const b=[...document.querySelectorAll('button')]
    .find(x=>x.getAttribute('aria-label')===${JSON.stringify(label)});
  if(!b)return false;
  b.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,isPrimary:true}));
  b.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,button:0,isPrimary:true}));
  b.click();return true})()`)
const menuItem = (label) => ev(`(()=>{const m=[...document.querySelectorAll('[role=menuitem]')]
    .find(x=>x.textContent.includes(${JSON.stringify(label)}));if(m){m.click();return true}return false})()`)

// Several header buttons left the deck list for the shell's Create menu, so
// reaching them is two steps now. Matched on an exact label, because the deck
// dialog's own submit button also begins with "Create".
const createMenu = async (label) => {
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Create');
    if(!b)return false;
    b.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,isPrimary:true}));
    b.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,button:0,isPrimary:true}));
    b.click();return true})()`)
  await until(`document.querySelectorAll('[role=menuitem]').length > 0`, 'create menu')
  await menuItem(label)
}
const newDeck = () => createMenu('New deck')

await newDeck()
await until(`!!document.getElementById('deck-name')`, 'deck dialog')
await setInput('deck-name', 'Biochemistry')
await wait(200)
await click('Create deck')
await until(`!document.getElementById('deck-name')`, 'dialog closed')
await wait(600)
ok((await deckNames()).includes('Biochemistry'), 'a deck can be created')

// `::` is Anki's path separator, so it cannot live inside one deck's name.
await newDeck()
await until(`!!document.getElementById('deck-name')`, 'deck dialog 2')
await setInput('deck-name', 'Heart::Valves')
await until(`document.body.innerText.includes('separates')`, 'separator warning')
await click('Create deck')
await until(`!document.getElementById('deck-name')`, 'dialog closed 2')
await wait(600)
const named = await deckNames()
ok(named.includes('Heart Valves') && !named.includes('Heart::Valves'),
   'a name carrying :: becomes one deck, not two')

// Sibling names are unique, or an Anki path could not resolve to one deck.
await newDeck()
await until(`!!document.getElementById('deck-name')`, 'deck dialog 3')
await setInput('deck-name', 'Biochemistry')
await wait(200)
await click('Create deck')
await until(`document.body.innerText.includes('already a deck called')`, 'clash refused')
ok(true, 'two sibling decks cannot share a name')
await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Cancel')?.click()`)
await wait(400)

await send('Page.navigate', { url: URL_UNDER_TEST })
await until(`document.body.innerText.includes('Study now')`, 'reload')
ok((await deckNames()).includes('Biochemistry'), 'the new deck survived a reload')

await openMenu('Biochemistry options')
await until(`document.querySelectorAll('[role=menuitem]').length > 0`, 'deck menu')
await menuItem('Delete')
await until(`document.body.innerText.includes('Delete Biochemistry?')`, 'delete confirm')
ok(await ev(`document.body.innerText.includes('empty')`),
   'deleting states what it would take with it')
await click('Delete deck')
await wait(800)
ok(!(await deckNames()).includes('Biochemistry'), 'the deck is gone')

// ── Phase 3: adding without leaving ────────────────────────────────────────
section('authoring at volume')
await click('Pharmacology')
await until(`document.body.innerText.includes('New note')`, 'browser')
await click('New note')
await until(`document.body.innerText.toUpperCase().includes('PREVIEW')`, 'editor')

// `nth` is the running total the counter must reach — waiting on the generic
// "added this session" would be satisfied by the *previous* note's counter.
const addOne = async (front, back, nth) => {
  await focusField(0); await clearField(); await type(front)
  await focusField(1); await clearField(); await type(back)
  await until(`document.body.innerText.includes('1 card')`, `generated ${front}`)
  await click('Add note')
  const plural = nth === 1 ? 'note' : 'notes'
  await until(`document.body.innerText.includes('${nth} ${plural} added this session')`,
              `added ${front}`)
}
await addOne('Half-life of aspirin?', 'Dose dependent, 2-3 h at low dose.', 1)
ok(true, 'adding keeps you in the editor')
ok(await ev(`document.querySelectorAll('[role=textbox]')[0].innerText.trim() === ''`),
   'the fields cleared for the next note')
ok(await ev(`document.activeElement === document.querySelectorAll('[role=textbox]')[0]`),
   'the cursor went back to the first field')

await addOne('First-pass metabolism happens where?', 'Liver, and gut wall.', 2)
ok(true, 'a second note without leaving the screen')

// The duplicate warning is advisory, not a block.
await focusField(0); await clearField(); await type('Half-life of aspirin?')
await focusField(1); await clearField(); await type('x')
await until(`document.body.innerText.includes('duplicate')`, 'duplicate warning')
ok(true, 'a repeated first field is flagged as a duplicate')

await click('Done')
await until(`document.body.innerText.includes('New note')`, 'back in the browser')
ok(await ev(`document.body.innerText.includes('Half-life of aspirin')`),
   'both notes landed in the deck')

// ── note types ─────────────────────────────────────────────────────────────
// The half of Phase 3 that can detach a field from its content across a whole
// collection: renaming a field, and moving a note to another type. The pure
// remapping has unit tests; what is checked here is that the note's content
// actually followed it through the database.
section('note type management')
await click('All decks')
await until(`document.body.innerText.includes('Study now')`, 'deck list')
await createMenu('Note types')
await until(`document.body.innerText.includes('What fields a note has')`, 'note types')

await clickSelector('[aria-label="Clone Basic"]', 'the note type list')
await until(`!!document.querySelector('[aria-label="Field 1 name"]')`, 'the clone opened')
ok(await ev(`document.querySelector('input').value.includes('Basic copy')`),
   'cloning a built-in gives an editable copy')

// Rename the first field. A built-in could not be edited at all, which is the
// point of cloning first.
const setField = async (n, value) => {
  await ev(`(()=>{const el=document.querySelector('[aria-label="Field ${n} name"]');
    const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    set.call(el,${JSON.stringify(value)});
    el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
}
await setField(1, 'Term')
await until(`document.querySelector('[aria-label="Field 1 name"]').value === 'Term'`, 'renamed')
await click('Save note type')
await until(`document.body.innerText.includes('What fields a note has')`, 'saved')
ok(true, 'a field can be renamed on a custom note type')

// Now move a real note onto it, which is the repair path a bad import needs.
await click('Decks')
await until(`document.body.innerText.includes('Study now')`, 'deck list')
await click('Pharmacology')
await until(`document.body.innerText.includes('New note')`, 'browser')
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Half-life of aspirin'));b.click();return true})()`)
await until(`document.body.innerText.includes('Edit note')`, 'editor')

await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='Change note type');b.click();return true})()`)
await until(`document.body.innerText.includes('Change note type')`, 'change dialog')
await ev(`(()=>{const b=[...document.querySelectorAll('button[role=combobox]')].find(x=>x.textContent.includes('Choose a note type'));b.click();return true})()`)
await until(`[...document.querySelectorAll('[role=option]')].some(o=>o.textContent.includes('Basic copy'))`, 'type list')
await ev(`[...document.querySelectorAll('[role=option]')].find(o=>o.textContent.includes('Basic copy')).click()`)
// The field map defaults to same-name-then-same-position, so "Front" lands in
// "Term" with nothing to choose.
await until(`document.body.innerText.includes('Term')`, 'field map')
ok(true, 'the field map offers a default rather than an empty form')
await click('Change type')
await until(`document.body.innerText.includes('New note')`, 'back in the browser')
ok(await ev(`document.body.innerText.includes('Half-life of aspirin')`),
   'the note kept its content through the type change')

// ── Anki round trip ────────────────────────────────────────────────────────
// CARDS.md §10's real check for Phase 4: export the collection, feed the file
// straight back in, and expect every note to be *matched* rather than added.
// Anything less means the guid never survived the trip, and a shared deck
// could never ship a second version without duplicating everything.
section('anki round trip')
await click('All decks')
await until(`document.body.innerText.includes('Study now')`, 'deck list')

const downloads = mkdtempSync(join(tmpdir(), 'recall-apkg-'))
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })

/** The export toast, which states what actually went into the file. */
const exported = async () => {
  for (let i = 0; i < 80; i++) {
    const m = (await text()).match(/Exported (\d+) notes, (\d+) cards, (\d+) reviews/)
    if (m) return { notes: +m[1], cards: +m[2], reviews: +m[3] }
    await wait(250)
  }
  return null
}

const waitingBefore = await ev(`document.body.innerText.match(/(\\d+) cards waiting/)?.[1] ?? '0'`)
await createMenu('Export .apkg')
const first = await exported()
ok(!!first, `export reported its contents (${JSON.stringify(first)})`)
ok(!!first && first.reviews > 0, 'the review history went into the file')

let apkg = null
for (let i = 0; i < 80 && !apkg; i++) {
  const done = readdirSync(downloads).filter((f) => f.endsWith('.apkg'))
  if (done.length) apkg = join(downloads, done[0])
  else await wait(250)
}
ok(!!apkg, 'export wrote an .apkg')
ok(apkg && statSync(apkg).size > 1000, 'the archive is not empty')

// Straight back in through the real file input, so the import under test is
// the one the button runs.
const rootDoc = await send('DOM.getDocument')
const fileInput = await send('DOM.querySelector', {
  nodeId: rootDoc.result.root.nodeId, selector: 'input[type=file]',
})
await send('DOM.setFileInputFiles', { files: [apkg], nodeId: fileInput.result.nodeId })

await until(`document.body.innerText.includes('Imported')`, 'import report', 240)
const reportText = await text()
const figure = (label) => {
  const m = reportText.match(new RegExp(label.replace(/[[\]]/g, '\\$&') + '\\s+(\\d+)'))
  return m ? +m[1] : -1
}
ok(figure('notes added') === 0, `nothing was duplicated (added ${figure('notes added')})`)
ok(figure('notes updated') > 0, `every note matched on its guid (${figure('notes updated')})`)

await click('Close')
await until(`document.body.innerText.includes('Study now')`, 'deck list again')

// CARDS.md §10: note, card and review counts all stable across the trip. The
// review check is the one with teeth — an answer that arrives back under a new
// id is a second row for a moment that only happened once.
await wait(4500) // let the first toast clear, or its text is read again
await createMenu('Export .apkg')
const second = await exported()
ok(!!second && first && second.notes === first.notes && second.cards === first.cards,
   `notes and cards are stable (${JSON.stringify(second)})`)
ok(!!second && first && second.reviews === first.reviews,
   `the review log did not double (${first?.reviews} → ${second?.reviews})`)
const waitingAfter = await ev(`document.body.innerText.match(/(\\d+) cards waiting/)?.[1] ?? '0'`)
ok(waitingAfter === waitingBefore,
   `the card count survived the round trip (${waitingBefore} → ${waitingAfter})`)
rmSync(downloads, { recursive: true, force: true })

// ── offline ────────────────────────────────────────────────────────────────
/**
 * The app on a plane.
 *
 * Every section above already runs with **no API server**, which is the data
 * half of offline-first and the half people usually mean. This is the other
 * half: no network *at all*, so the HTML, the JavaScript and the 856 kB sqlite
 * wasm have to come from the service worker or nothing loads and none of the
 * rest of it matters.
 *
 * It runs last on purpose. Cutting the wire is a global change to the browser,
 * and a section after it would be testing something nobody asked about.
 */
section('offline')

// The worker registers after `load` and only on a production build, so give it
// a navigation to take control on before the wire is cut.
await send('Page.navigate', { url: URL_UNDER_TEST })
await until(`document.body.innerText.includes('Study now')`, 'deck list, warm')
await until(`!!navigator.serviceWorker.controller`, 'service worker in control')

// Clear the HTTP cache before the visit that is supposed to populate the
// worker's. Without this the test passes for the wrong reason: Chrome's memory
// cache satisfies `/assets/` across navigations in the same tab, the fetch
// events never reach the worker, and the app loads "offline" from a disk cache
// that is evictable and was never the plan. Everything after this line is
// therefore the service worker or nothing.
await send('Network.enable')
await send('Network.clearBrowserCache')

await send('Page.navigate', { url: URL_UNDER_TEST })
await until(`document.body.innerText.includes('Study now')`, 'deck list, controlled')
const cached = await ev(
  `caches.open('recall-shell-v1').then(c=>c.keys()).then(k=>k.map(r=>new URL(r.url).pathname))`)
ok(cached.length > 1, `the shell and its assets are cached (${cached.length} entries)`)
ok(cached.some((p) => p.endsWith('.wasm')),
   'including the sqlite wasm, without which nothing opens')

const waiting = () => ev(`document.body.innerText.match(/(\\d+) cards waiting/)?.[1] ?? null`)
const dueBefore = await waiting()

await send('Network.emulateNetworkConditions', {
  offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
})

// A cold start with nothing on the other end of the wire.
await send('Page.navigate', { url: URL_UNDER_TEST })
await until(`document.body.innerText.includes('Study now')`, 'deck list with the network off')
ok(true, 'the app starts with no network at all')
ok(await waiting() === dueBefore, 'the collection is all there (' + dueBefore + ' waiting)')

// An answer given offline has to reach OPFS, not a queue in memory: a tab that
// is closed before the connection returns must not lose the review.
await click('Study now')
await until(`!!document.querySelector('header span')`, 'review screen, offline')
const offlineBefore = await counter()
await key(' ')
await until(`document.body.innerText.includes('Again')`, 'reveal, offline')
await key('3')
await until(`document.querySelector('header span').textContent !== ${JSON.stringify(offlineBefore)}`, 'next card, offline')
const offlineAfter = await counter()

await send('Page.navigate', { url: URL_UNDER_TEST })
await until(`document.body.innerText.includes('Study now')`, 'reload, still offline')
await click('Study now')
await until(`!!document.querySelector('header span')`, 'review after an offline reload')
ok((await counter()) === offlineAfter,
   `an answer given offline survived a reload (${offlineBefore} → ${offlineAfter})`)

// Back on the wire, so nothing downstream inherits a dead network.
await send('Network.emulateNetworkConditions', {
  offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
})

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
