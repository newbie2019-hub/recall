# Recall — architecture plan (web first)

**Web now:** React + TypeScript + Three.js + shadcn/ui + Vite.
**Server:** Laravel (API, auth, marketplace, sync, queues, Reverb websockets).
**Mobile later:** React Native — *not* a rewrite, it consumes `packages/core`.

---

## 0. The three conflicts in the brief

The feature list contains three pairs that actively fight each other. Every
architectural decision below exists to resolve one of them.

### Conflict 1 — offline-first vs. live collaboration vs. Laravel

Offline-first wants a local database and an event log. Live collaboration wants
CRDTs and a websocket server. Laravel is a request/response PHP framework and is
not a sync engine. Trying to serve all three with one mechanism is how this
project dies.

**Resolution — two data classes, two sync mechanisms:**

| Data class | Example | Writers | Sync |
|---|---|---|---|
| **Personal** | your reviews, scheduling state, streaks, settings | exactly one (you) | append-only event log → plain REST batch to Laravel |
| **Shared** | deck contents being co-edited | many | Yjs CRDT over Laravel Reverb |

Personal data *cannot* conflict — only one device-owner ever writes your review of
your card. So it needs no merge algorithm at all, just a union of rows. That is
what makes offline-first cheap here.

Shared data is where merging is hard, so it gets the one tool built for it (Yjs),
and only there.

### Conflict 2 — offline vs. heavy assets

3D anatomy is ~33 MB. Medical decks are image- and audio-heavy and run to
gigabytes. "Everything available offline" is not a thing browsers will give you.

**Resolution:** offline is **per-deck opt-in**. Card *text* and scheduling for all
decks sync always (tiny). Media and 3D assets download only when the user taps
"Make available offline" on that deck, with a visible size estimate and a storage
manager. Use the StorageManager API (`navigator.storage.persist()`) so the browser
does not evict the collection.

### Conflict 3 — "support Anki very well" vs. "better than Anki"

Anki fidelity means note types, card templates, and Anki's `{{Field}}` /
`{{cloze:Text}}` template language. That is exactly the complexity that makes Anki
hostile to new users.

**Resolution:** two tiers.
- **Native kinds** (basic, reverse, cloze, image occlusion, multiple choice, 3D
  structure) — fixed layouts, no template editor, what new users see.
- **Imported note types** — rendered by a compatibility template engine in a
  sandboxed iframe. Editable as fields; the template itself is read-only unless
  the user opens "Advanced".

Importers get fidelity. Newcomers never see a template.

---

## 1. Key technical decisions

| Area | Decision | Reason |
|---|---|---|
| Scheduler | [`ts-fsrs`](https://open-spaced-repetition.github.io/ts-fsrs/) on the client, [`scottlaurent/fsrs`](https://packagist.org/packages/scottlaurent/fsrs) or [`fsrs-rs-php`](https://github.com/open-spaced-repetition/fsrs-rs-php) on the server | The client **must** schedule offline. Server mirrors it for dashboards and optimization. Never write your own SM-2. |
| Local store | **SQLite WASM on OPFS**, `opfs-sahpool` VFS, in a dedicated worker with Web Locks leader election | Real SQL in the browser. Same schema and the same recursive-CTE deck queries as MySQL, and the same SQL again in React Native via op-sqlite. See §2.5 — the VFS choice is not optional. |
| Personal sync | Append-only `reviews` log, batch POST, `since` cursor pull. Content is **row-level** last-write-wins on `client_updated_at`. | Single-writer ⇒ no conflict resolution code at all. Row-level, not per-field: two offline edits to different fields of one note keep only the later note. Marked `ponytail:` in `SyncService::push` — per-field needs a `field_updated_at` map on both sides, and §0's Yjs path is the real answer for genuine co-editing. |
| Shared sync | Yjs updates stored as **opaque binary blobs** in MySQL, fanned out over Laravel Reverb, materialized into local SQLite on apply | PHP cannot run Yjs — and does not need to. Yjs updates are commutative: the server appends blobs and hands back the set; clients merge. Periodic snapshot compaction keeps the log bounded. |
| 3D anatomy *(post-launch)* | Fork [`ashemag/human-atlas`](https://github.com/ashemag/human-atlas) — MIT code, CC BY 4.0 data, 2,234 selectable BodyParts3D meshes, 3,432 searchable concepts, ~33 MB | **Already React + Three.js + shadcn.** Deferred by decision; see CRITIQUE.md for what deferring costs. |
| Math | KaTeX primary, MathJax lazy-loaded fallback | KaTeX renders sub-second; MathJax has been measured at ~5s for a single fraction in Anki. Imported cards use Anki's `\(...\)` / `\[...\]` delimiters — map them. |
| `.apkg` import | Laravel **queued job**: unzip → zstd-decompress → SQLite read. A **client-side importer too**, kept as the offline path. | Modern exports are `collection.anki21b`, zstd-compressed, schema v18, with protobuf blobs in some columns. Phase 4 built the browser one first, because there was no server to queue on yet, and it is the only one that works signed out. Phase 5 adds the job: an import that lands in MySQL reaches *every* device, not just the one that ran it. |
| PDF/image → cards | Queued job → LLM → **human approval screen** | Never auto-insert generated cards. Bad cards are worse than no cards. |
| Auth | **Sanctum bearer tokens, one per device**, sliding 60-day expiry. No cookie/SPA mode. A 401 never blocks studying. | React Native cannot do Sanctum's SPA cookie mode, and two auth paths means two refresh bugs. See §2.6. |
| Monorepo | `packages/core` (framework-agnostic TS: FSRS wrapper, schema, sync, template engine) + `apps/web` + later `apps/mobile` | RN is a *stated* goal, so this is not speculative abstraction. Anything importing `react-dom` or `three` stays out of core. |

---

## 2. Data model

```
users
decks(id, parent_id, name, owner_id, retention_target, new_per_day, visibility)
note_types(id, name, fields_json, templates_json, css, is_native)
notes(id, note_type_id, deck_id, fields_json, tags, updated_at, yjs_doc_id)
cards(id, note_id, ord, due, stability, difficulty, state, reps, lapses)
concepts(fma_id, name, parent_fma_id)                    -- FMA ontology, see ASSETS-3D.md
notes.fma_id                                             -- nullable; add in Phase 0, not later
reviews(id, card_id, user_id, ts, rating, duration_ms)   -- APPEND ONLY
media(id, note_id, kind, path, sha256, bytes)
deck_versions(id, deck_id, semver, changelog)            -- marketplace
deck_clones(id, source_deck_id, cloned_deck_id, at_version)

-- As built in Phase 8. The sketch above kept the version beside the deck; the
-- build split the two, because a listing outlives the deck it was cut from and
-- the takedown switch has to live somewhere a deletion cannot reach:
listings(id, user_id, deck_id, title, tags, visibility, status,
         latest_version, install_count, rating_count, rating_sum,
         open_report_count, moderated_by, moderated_at, moderation_reason)
listing_versions(id, listing_id, version, semver, changelog, payload,
                 checksum, rights_attestation, attested_ip)   -- IMMUTABLE
listing_installs(id, listing_id, user_id, deck_id, version)   -- no FK to decks
listing_ratings(id, listing_id, user_id, stars)               -- installs only
listing_reports(id, listing_id, reporter_id, kind, reason, detail, status, …)
listing_moderation_events(id, listing_id, moderator_id, action,
                          resulting_status, reason)           -- APPEND ONLY
yjs_updates(id, doc_id, blob, created_at)                -- collab log
yjs_snapshots(doc_id, blob, up_to_update_id)             -- compaction

-- As built in Phase 9. Same idea, three differences worth the renaming:
-- `seq` is an auto-increment because it is the cursor a reconnect resumes from,
-- the payload is base64 text so the server never touches bytes it has promised
-- not to read, and the doc is keyed by deck because one deck is one document:
deck_collaborators(id, deck_id, user_id, invited_email, role,
                   invited_by, accepted_at)   -- role: viewer|editor|admin
doc_updates(seq, deck_id, actor_id, payload, created_at)      -- APPEND ONLY
doc_snapshots(deck_id, payload, up_to_seq, actor_id)          -- client-produced
```

Two rules that everything else depends on:

1. **`reviews` is append-only.** Never `UPDATE`, never `DELETE`. Scheduling state
   in `cards` is a derived cache that can be rebuilt by replaying the log. This is
   what makes offline sync a row-union, what makes FSRS optimization possible, and
   what makes the dashboard honest.
2. **Decks are a `parent_id` tree.** Nested decks are then free, and so are
   rolled-up counts — one recursive CTE.

---

## 2.5 Local storage architecture (SQLite WASM)

Chosen: **SQLite compiled to WASM, persisted on OPFS.** Three constraints follow
from that, and getting any of them wrong costs a rewrite.

### VFS choice: `opfs-sahpool`, not `opfs`

sqlite-wasm ships two OPFS backends:

| VFS | Multi-tab concurrency | Needs COOP/COEP | Speed |
|---|---|---|---|
| `opfs` | yes | **yes** (SharedArrayBuffer) | slower |
| `opfs-sahpool` | no (single connection) | **no** | fastest |

Take **`opfs-sahpool`**. Requiring cross-origin isolation would mean COOP/COEP
headers on every response, which breaks third-party embeds and CDN-loaded
assets — including the 33 MB of anatomy meshes later.

### Getting multi-tab back: Web Locks leader election

> **Corrected during Phase 0, verified in Chrome.** This originally said a
> SharedWorker owns the connection. It cannot:
> `FileSystemFileHandle.createSyncAccessHandle` is **`[Exposed=DedicatedWorker]`**,
> so opfs-sahpool fails inside a SharedWorker with *"Missing required OPFS APIs"*
> — and Chrome does not allow a SharedWorker to spawn a nested dedicated worker
> either (`Worker is not defined`). Both were probed in-browser before changing
> the design.

So: **one dedicated worker per tab, one Web Lock.**

- Every tab's worker queues on the same exclusive lock (`recall-db-owner`).
- The holder opens the database and serves the other tabs over a
  **BroadcastChannel**; followers proxy their queries to it.
- When the leader's tab closes the lock releases and the next waiter opens the
  database automatically — no handover code.
- A BroadcastChannel never delivers a message back to the context that posted
  it, so the follower path must re-check leadership on every retry: the first
  query usually arrives before this worker has finished winning the lock, and
  would otherwise broadcast into a void only it could answer.
- This also removes the Chrome-on-Android SharedWorker caveat — there is no
  SharedWorker left to be missing.

### Eviction is a real threat to "offline-first"

- Call `navigator.storage.persist()` on first run **and on every launch** — the
  grant is not guaranteed sticky.
- Safari's ITP clears script-writable storage after **7 days without
  interaction**. Home-screen web apps have their own counter, but a browser-tab
  user who studies fortnightly can lose local state.
- Therefore: **unsynced review rows are the only irreplaceable data.** Push them
  eagerly — on every session end, not on a timer. Everything else can be re-pulled
  from Laravel. Design the app so that losing local storage is an inconvenience,
  never a loss.

### Migrations

One migration list in `packages/core`, applied to the browser DB via
`PRAGMA user_version`. Laravel keeps its own migrations for MySQL; the two are
reviewed together in the same PR. Keep SQL portable — no MySQL-only syntax in
queries that `core` shares.

### Yjs ↔ SQLite

While a deck is open for collaborative editing, the **Yjs doc is authoritative**
for its notes. On every applied update, materialize the changed notes into local
SQLite so search, study, and offline work keep reading one source. Never edit
those rows directly during a collab session — write to the Y.Doc and let the
observer write the rows.

---

## 2.6 Authentication & the API contract

Auth was named in three places (Sanctum, "accounts, devices", collab roles) and
specified in none. It is decided here, once, because **the mobile app is a stated
goal and auth is the single hardest thing to retrofit across two clients.**

### The offline-first auth invariant

> **A 401 must never take the collection away.**

Signed out, expired, revoked, server down — the app keeps studying. Local SQLite
is the source of truth; the account is how rows *leave* the device, not how they
are read. Everything below follows from that one line:

- No auth gate in front of the app shell. The first screen is a deck list, and it
  renders from OPFS before any network call is made.
- Sign-in is a state (`synced` / `sync paused` / `local only`), never a wall.
- Losing a token queues the unsynced `reviews` rows and shows one banner. It never
  clears local data, and it never blocks a review.
- Account deletion and sign-out are different actions with different consequences,
  and sign-out must say whether unsynced rows exist before it wipes anything.

### Bearer tokens for both clients, one code path

| | Decision |
|---|---|
| Scheme | **Laravel Sanctum personal access tokens**, `Authorization: Bearer …` |
| Not | Sanctum's SPA cookie mode |
| Not | Passport / OAuth2 |

Sanctum's SPA mode needs same-site cookies, a CSRF round-trip and shared
top-level domains. React Native has none of that. Running cookie auth on web and
token auth on mobile means two auth paths, two refresh bugs, and two sets of
middleware — for a first-party client that has no third-party consumers, that is
pure cost. Passport buys refresh-token rotation and PKCE, which matter when
*other people's* apps hold your users' credentials. Nobody else is holding these.

**One token per device**, named for it (`"Yvan's iPhone"`), so the account screen
lists devices and revoking one signs out exactly that phone. This falls out of the
`devices` table Phase 5 already needs for sync cursors — the token and the cursor
belong to the same row.

**Where the token lives:** in local SQLite on web, Keychain / Keystore on mobile.
The obvious objection to web is XSS, and the honest answer is that an
offline-first app has already lost that argument: script running on our origin
can read the entire OPFS collection, so an httpOnly cookie would be protecting
the key to a door that is already open. Spend the effort on CSP and on not
`innerHTML`-ing untrusted card content (§3.5 — that is why cards render in a
sandboxed iframe), not on a cookie that buys nothing here.

### Token lifetime, given that "offline" can mean weeks

A never-expiring token on a lost phone is a standing liability. A short-lived one
breaks a user who studies on a plane for a fortnight. So: **sliding expiry.**

- Tokens carry `expires_at`, 60 days out.
- Any authenticated request inside the window pushes it out again (one middleware,
  throttled to one write per day per token).
- Past the window the device re-authenticates. It has lost nothing — it queues
  and keeps studying.

Sixty days of *no sync at all* is the point at which asking for a password again
is reasonable rather than hostile.

### Identity

- Email + password (Argon2id), plus **Sign in with Google** and **Sign in with
  Apple**.
- **Apple is not optional:** App Store Review Guideline 4.8 requires Sign in with
  Apple in any iOS app offering third-party sign-in. Add it when the web app adds
  Google, not when the iOS build is in review.
- Email verification before **publishing** to the marketplace, not before
  studying. Gate the thing with abuse potential, nothing else.

### API rules that exist because of the mobile app

A web client is updated by a hard refresh. A phone is not: old builds live on
devices for months, on bad networks, with the process killed mid-request. These
are cheap now and very expensive to retrofit.

| Rule | Why the phone forces it |
|---|---|
| **Version the path** — `/api/v1/…` | You cannot force-update an installed app. v1 has to keep answering after the web app has moved on. |
| **Bearer only, no CSRF, no session state** | Stateless auth is the only kind RN can do without a cookie jar. |
| **Client-generated UUIDs as primary keys** | A retried push must not duplicate. `INSERT … ON CONFLICT(id) DO NOTHING` makes the whole review push idempotent for free — the append-only log paying for itself again. |
| **Cursor pagination, never page numbers** | Sync pulls tens of thousands of rows while new ones are being written; offset pagination silently skips rows. |
| **Both timestamps on every review** — `client_ts` *and* `server_received_at` | Phone clocks are wrong and users change timezones mid-flight. `replayReviews()` needs the client's ordering, but the server must not be fooled by it. Clamp absurd values, never rewrite them. |
| **Chunked, resumable media upload**, content-addressed by sha256 | A 40 MB deck upload on mobile data will be interrupted. sha256 means an interrupted upload resumes instead of restarting, and identical media is stored once. **Not built.** `media` rows sync as metadata and the bytes have no endpoint in either direction, which is why a published deck's images do not travel (PHASES.md §8). The first cut can be single-shot per file — resumability is the second. |
| **`ETag` / `If-None-Match` on deck and media reads** | Metered connections. A no-op sync should cost a few hundred bytes. |
| **Envelope every list response** — `{ data, next_cursor, server_time }` | `server_time` lets a client detect its own clock skew without an extra endpoint. |
| **Errors as a stable shape** — `{ error: { code, message } }`, code is a string | An old build has to branch on something that will not be reworded. |

### The API client lives in `packages/core`

Not in `apps/web`. The typed request/response shapes, the cursor bookkeeping, the
retry-and-queue logic and the 401 handling are written once and imported by both
clients — the same reason the schema and the FSRS wrapper live there. Anything
that reaches for `fetch` is fine; anything that reaches for `localStorage` or
`AsyncStorage` takes it as an injected adapter.

### The screens auth actually needs

Deciding the mechanism is not the same as designing the pages, so: sign in,
create account, forgot password, reset password, and a Settings surface carrying
profile, **devices** (one row per token, revoke = sign out that phone), storage,
scheduling defaults, appearance and data export. Laid out in UI.md §4 — including
the one decision that had to be made before any of them was written:

> **Signing into account B on a device already holding account A's collection.**
> **Settled in Phase 5: always adopt the local rows into the account being
> signed into.** Nothing is destroyed, which is the constraint that mattered —
> local `reviews` are the only irreplaceable data on the device. The cost was
> accepted knowingly: a borrowed or shared device donates its review history to
> whoever signs in next, with no prompt. The alternatives were keep-both-and-
> switch (a separate OPFS database per account, days of work) and refuse-until-
> resolved (safest, one more step for the common case).

**Build order:** the token endpoints and the `devices` table land in **Phase 5**
with sync, because that is the first moment either has a job. Nothing in Phases
0–4 talks to a server, and auth built before it is needed is auth built against
guesses. The **router** lands at the start of Phase 5 too, immediately before the
auth pages — a reset link has to land on a URL, and Phase 12's universal links
have to resolve to the same paths (UI.md §6).

---

## 3. Where this beats Anki (keep these visible; they are the product)

1. **No template editor for normal users.** Fixed card kinds. Anki's flexibility is used by ~5% and taxes 100%.
2. **One knob: desired retention.** FSRS collapses Anki's ~30 deck options into one number. Everything else behind "Advanced".
3. **A dashboard that names weaknesses**, not review counts. *Which topics you fail, which cards are leeches and why.* Anki graphs volume; nobody needs volume.
4. **Co-editing a deck.** Anki has no concept of this. Study groups and lab cohorts are the wedge.
5. **Medical 3D as a first-class card type** — "click the structure" is a card, not a separate atlas tab, and it is scheduled by FSRS like any other card.
6. **Import, don't lock in.** `.apkg` in *and* out.

---

## 3.5 Anki card-type support matrix (non-negotiable for "supports Anki well")

> Summary only. **[CARDS.md](CARDS.md)** is the working document: the authoring
> flow, the full filter list with what is built and what is not, deck override,
> sibling burying, note-type management, and the migration all of it implies.

A **note** holds fields. A **note type** owns N **card templates**. Each template
that renders a non-empty front produces one **card**. Getting this one rule right
is what makes every stock and custom Anki type work, because they are all just
templates over that rule.

### Stock note types

| Anki type | Cards per note | Mechanism | Native or compat |
|---|---|---|---|
| Basic | 1 | Front → Back | Native |
| Basic (and reversed card) | 2 | second template swaps Front/Back | Native |
| Basic (optional reversed card) | 1 or 2 | `{{#Add Reverse}}` conditional — card 2 exists only if that field is filled | Native (conditional generation required) |
| Basic (type in the answer) | 1 | `{{type:Back}}` — text input, character-level diff on reveal | Native |
| Cloze | 1 per distinct `c<N>` | `{{c1::text}}`, `{{c1::text::hint}}`, nesting to 3 levels | Native |
| Image Occlusion | 1 per shape (or 1 total) | rect / ellipse / polygon masks; **Hide All, Guess One** and **Hide One, Guess One** | Native |

### Template language the compat renderer must implement

| Feature | Syntax | Notes |
|---|---|---|
| Field substitution | `{{Field}}` | HTML by default |
| Plain text | `{{text:Field}}` | strips HTML |
| Conditional | `{{#Field}}…{{/Field}}`, `{{^Field}}…{{/Field}}` | drives optional-reverse card generation |
| Back side | `{{FrontSide}}` | re-renders the front |
| Typed answer | `{{type:Back}}`, `{{type:cloze:Text}}` | needs diff rendering |
| Cloze | `{{cloze:Text}}` | with per-card index |
| Hint | `{{hint:Field}}` | click-to-reveal |
| Special | `{{Tags}} {{Type}} {{Deck}} {{Subdeck}} {{Card}}` | |
| Japanese | `{{furigana:}} {{kana:}} {{kanji:}}` | ship as a filter plugin, low priority |
| Per-note-type CSS | `.card { … }` | applies to all its templates |
| Deck override | template-level | a template can send its cards to another deck |

### Generation rule

> Render the front template against the note's fields. If the result contains no
> field content (only static text/HTML), **no card is generated** for that
> template. Editing a note re-runs generation: new templates create cards,
> emptied conditionals leave existing cards orphaned — Anki keeps them, so keep
> them too and mark them.

**Three gaps this table hides**, each written up in CARDS.md: **deck override**
(a template can send its cards to another deck — we list it and implement none of
it, and an import that collapses it is a silent lie), **cloze conditionals**
`{{#c1}}`, and **sibling burying**. All three are Phase 3 work, landing
before Phase 4's importer rather than after it.

**Implementation:** one `renderTemplate(noteType, note, ord)` in `packages/core`,
pure, no DOM. The web app paints its output into a sandboxed iframe (imported CSS
is untrusted). React Native reuses the same function with a WebView. Write the
test suite for this against the six stock types before writing the renderer —
it is the single most breakage-prone unit in the codebase.

---

## 4. Reference

- Anki manual — [deck options](https://docs.ankiweb.net/deck-options.html) · [editing](https://docs.ankiweb.net/editing.html) · [math](https://docs.ankiweb.net/math.html)
- FSRS — [fsrs-rs](https://github.com/open-spaced-repetition/fsrs-rs) · [ts-fsrs](https://open-spaced-repetition.github.io/ts-fsrs/) · [fsrs-rs-php](https://github.com/open-spaced-repetition/fsrs-rs-php)
- apkg format — [format writeup](https://eikowagenknecht.com/posts/understanding-the-anki-apkg-format/) · [anki-apkg-parser (Node)](https://github.com/74Genesis/anki-apkg-parser)
- 3D — **see `ASSETS-3D.md`** · [human-atlas](https://github.com/ashemag/human-atlas) · [Z-Anatomy](https://github.com/Z-Anatomy) (CC BY-SA) · [AnatomyTOOL Open3Dmodel](https://anatomytool.org/open3dmodel)
- Collab — [Yjs](https://github.com/yjs/yjs) · [Laravel Reverb](https://reverb.laravel.com/)
- Offline — [sqlite-wasm persistence docs](https://sqlite.org/wasm/doc/trunk/persistence.md) · [Notion's WASM SQLite writeup](https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite) · [State of SQLite persistence on the web](https://powersync.com/blog/sqlite-persistence-on-the-web)
