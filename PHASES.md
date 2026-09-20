# Recall — phased implementation

Decisions locked: **SQLite WASM + OPFS** local store · **full simultaneous
co-editing** · **public marketplace with day-one moderation** · **3D anatomy
deferred to post-launch**.

Rule for every phase: it ends with something you can actually use. Estimates
assume one developer.

**Status:** 0–4 ✅ · 5 ✅ (one line open: server-side FSRS) · 6 ✅ · 7 ✅ · 8 ✅ ·
**next: the media transport at the end of Phase 8, then Phase 9** · 10–12 planned.

Inside a phase, ✅ is landed and tested, ◻︎ is not started, ⚠️ is partly there and
says what is missing.

> **Renumbered.** Phase 3 was "Anki import & export, ~1.5 weeks". Three review
> passes loaded it with everything the importer turns out to depend on — note
> GUIDs, deck override, note-type management, deck creation — until it was four
> weeks wearing a 1.5-week label. It is now two phases, 3 and 4, and everything
> after shifted by one. Companion docs: **[PLAN.md](PLAN.md)** (architecture and
> auth) · **[CARDS.md](CARDS.md)** (card types and authoring) ·
> **[UI.md](UI.md)** (screens).

---

## Phase 0 — Skeleton, core package & storage spine · ~1.5 weeks · ✅

*(+0.5 wk vs. the Dexie plan — SQLite WASM costs setup and repays it later)*

- pnpm monorepo: `packages/core`, `apps/web`, (`apps/mobile` later).
- `apps/web`: Vite + React + TS + Tailwind + shadcn/ui.
- `packages/core`: no React, no DOM, no `three`. Schema, migrations, `ts-fsrs`
  wrapper, template renderer, sync client, **and the SQL** — this is what React
  Native reuses.
- **Storage spine:** `@sqlite.org/sqlite-wasm` with the `opfs-sahpool` VFS in a
  **dedicated worker per tab**, with a **Web Lock** electing the single database
  owner and a BroadcastChannel proxy for follower tabs. (Not a SharedWorker —
  OPFS sync access handles are dedicated-worker-only; see PLAN.md §2.5.)
- Migration runner on `PRAGMA user_version`.
- `navigator.storage.persist()` on every launch, not just first run.
- ~~Laravel scaffolded.~~ **Deferred to Phase 5.** Nothing before it touches a
  server, and a scaffold that sits unused for four phases rots.

**Done when:** write 10k rows, hard-refresh, close the browser, reopen — data is
there. Two tabs write concurrently without corrupting the file.

> **Built.** `apps/web/src/db/{worker,client,repo}.ts`, `packages/core/src/{schema,types}.ts`.
> One correction the build forced: the SharedWorker design was impossible —
> `createSyncAccessHandle` is `[Exposed=DedicatedWorker]`. See PLAN.md §2.5.
> A later pass found the follower-tab retry could execute a write **twice** if
> the leader was merely slow; replies are now cached by token.

---

## Phase 1 — Offline study loop · ~2 weeks · ✅

The product exists at the end of this phase.

- Review a deck, schedule with `ts-fsrs`, four buttons + undo.
- Append-only `reviews` table; card state derived via `replayReviews()`.
- Desired retention + new-cards/day, per deck.
- Card states new/learning/review/relearning; suspend, bury, flags.
- ~~Workbox service worker.~~ **Deferred to Phase 5**, where the media cache and
  sync queue decide what it actually has to hold.

**Done when:** airplane mode, review 50 cards, reopen, state intact.

> **Built.** `packages/core/src/scheduler.ts` (`enable_fuzz: false`, so replay is
> exact), `apps/web/src/components/{Review,RatingBar,SpecimenTag}.tsx`,
> `apps/web/e2e/app.mjs` — 37 assertions against real Chrome.
>
> Deck options were the late catch: `new_per_day` sat in the schema unread for
> two phases, so every new card was offered at once — the thing that makes a
> 20k-card import unusable on day one. The limit is charged against *first*
> reviews in the log, so it survives a cache rebuild, and `nextCard`, the deck
> badges and the session counter all read it from one place.

---

## Phase 2 — Note types, card types & authoring · ~2.5 weeks · ✅

Before import, because import targets this engine.

- Template engine in core: `{{Field}}`, `{{#Field}}`/`{{^Field}}`,
  `{{FrontSide}}`, `{{text:}}`, `{{hint:}}`, `{{cloze:}}`, `{{type:}}`,
  `{{occlusion:}}`, specials, filter chaining, unknown filters passed through.
- **Generation rule:** a front that renders to something ⇒ a card; re-runs on edit.
- Six native kinds: Basic · Basic+reversed · optional-reversed · type-in-answer
  (character diff) · Cloze · Image Occlusion.
- Nested decks — `parent_id` tree, one recursive CTE for rolled-up counts.
- Media: image and audio capture, content-addressed by sha256.
- **KaTeX**, all four Anki delimiter styles.
- Sandboxed iframe renderer — imported CSS/HTML is untrusted, no `allow-scripts`.

**Done when:** every stock Anki type renders.
**Check:** golden fixtures, one per stock type, written *before* the renderer.

> **Built.** `packages/core/src/{template,cloze,occlusion,diff,math,notetypes}.ts`
> — 27 fixture tests. Web: `CardFrame.tsx`, `NoteEditor.tsx`,
> `OcclusionEditor.tsx`, `Browse.tsx`, `lib/media.ts`.
>
> Skipped on purpose: **MathJax fallback** (a CDN fallback contradicts
> offline-first), **video capture** (the pipeline is mime-agnostic, only the UI
> is image + audio), **polygon drawing** (renders and imports, cannot be drawn).
>
> Three review passes then corrected the engine itself: field **emptiness** was
> stripping tags, so an image-only field counted as blank and `{{#Image}}` never
> fired; **cloze ordinals** were read from one field where Anki scans every
> field; and `{{c0::…}}` produced ordinal −1, a card id nothing could find again.

---

## Phase 3 — Decks, authoring at volume & the engine Anki needs · ~2 weeks · ✅

Everything the importer depends on, plus the reason to open the app at all: you
cannot currently **make a deck**, and adding twenty cards costs twenty
navigations. Written up in [CARDS.md](CARDS.md).

### Decks

- **Create / rename / move / delete**, including subdecks — the tree is
  `parent_id`, so "new subdeck" is the same call with a parent. *There is no way
  to create a deck today; the only `INSERT INTO decks` is the seeder.*
- Create inline from the note editor's deck picker — where most decks are really
  made.
- **`A::B::C` ↔ tree mapping.** Anki has no deck tree, only flat names with `::`.
  Import splits and creates missing ancestors; export joins the path back. Must
  round-trip losslessly, and `::` inside a deck name is the case that breaks it.
- Delete cascades to notes and cards; the review log is append-only and keeps
  its rows. Confirmation states the counts.

### Adding cards

- **Add without leaving** (`⌘↵`): save, clear non-sticky fields, keep the note
  type, deck and cursor, toast with undo. Twenty cards is one screen.
- **Sticky fields** — per-field "remember last input", stored on the note type.
- **Paste and drag-drop images.** The single worst effort-to-annoyance ratio in
  the app: a file picker is the slow path for the most common action there is.
  Paste-as-plain-text, and strip formatting on paste by default, as Anki does.
- **Duplicate warning** on the first field, non-blocking.
- **Tag autocomplete** over tags already in the collection.
- **The keyboard contract** — `⌘↵`, `⌘⇧C` / `⌘⌥⇧C` cloze, `⌘M` maths, `⌘⇧X` HTML
  view, `⌘1…9` fields. None of it is bound today.
- **Undo for add and edit.** Review undo exists; these do not.

### The engine

- **`notes.guid`** — mint once, never rewrite, export unchanged. Without it a
  re-import of an updated shared deck duplicates every note, and decks we export
  can never be updated by anyone. Everything in Phase 4 assumes it. *First.*
- First-field checksum for the duplicate warning — **not** how import matches.
- **Deck override** — a template can send its cards to another deck.
  `cards.deck_id` nullable, and `COALESCE(c.deck_id, n.deck_id)` in `deckTree`,
  `nextCard`, `counts` and `notesInDeck` — the four queries that must agree.
- Cloze conditionals `{{#c1}}`, `{{CardFlag}}`, `{{type:nc:}}`.
- **Note-type management:** add / rename / reposition / delete fields, sort
  field, change note type with an explicit field and template map. Also the
  repair path when an import maps badly, so it ships *before* the import.
- **Regeneration fan-out.** A note-type write must regenerate every note of that
  type, batched. Today `regenerateCards` runs only from `saveNote`, so adding a
  template to a 4,000-note type would create none of the 4,000 cards.

**Done when:** make a deck, paste a screenshot into a card, add twenty notes
without leaving the screen, then add a template to the note type and watch every
existing note grow a card that keeps its history.

> **Landed.** Decks, the `::` mapping, guid, deck override and the regeneration
> fan-out went in first; note-type management (fields, sort field, templates,
> CSS, change-note-type with an explicit field and template map) closed it out,
> along with the keyboard contract and `⌘⇧X`.
>
> Two things were found by building the exporter rather than by review. The
> **seeder wrote notes with no guid** — migration 3 backfilled the notes that
> existed when it ran, and the seeder inserted after it, so every collection
> created since had notes that could not be exported or matched on re-import.
> And **sticky fields lived in component state** while `ensureNoteTypes` rewrote
> every built-in row on boot, so the note type's own settings were the one place
> they could not have survived anyway.
>
> Deliberately not done: a template remap moves a card's scheduling to its new
> ordinal but leaves its review-log rows under the old card id, because the log
> is append-only. Marked `ponytail:` in `changeNoteType`; it wants sync to
> reconcile an id change (Phase 5).

---

## Phase 4 — Anki import & export · ~2 weeks · ✅

- Queued job: unzip → **zstd-decompress** `collection.anki21b` → read SQLite v18
  (protobuf blobs in config columns). Legacy `collection.anki2` too.
- Map note types and templates onto the Phase 2 engine; unmapped types keep raw
  templates through the compat path.
- Match notes on **guid**: same guid ⇒ update fields and tags in place, keep
  cards and scheduling. Never match on checksum.
- Carry the note-type fields we would otherwise drop — `latexPre`/`latexPost`,
  `bqfmt`/`bafmt`, `originalStockKind` — opaque, in one column, so a round-trip
  does not silently degrade someone's deck.
- Media import, rewrite `<img src>` and `[sound:]` onto content hashes.
- **Replay review history** into `reviews`, let FSRS re-derive stability.
- Export `.apkg` back out — no lock-in, and it is what makes the importer
  testable.
- **Measure LaTeX fidelity here.** KaTeX renders maths; `[latex]` blocks in the
  wild contain `\begin{tabular}` and `tikz`. Find out how often that actually
  bites before deciding between a render job and a documented limit.

**Done when:** a real 20k-card medical deck imports with history and renders.
**Check:** import → export → re-import; note, card and review counts stable.

> **Landed.** Both schemas read (11's JSON `models`/`decks`, 18's tables with
> protobuf config blobs), zstd for `collection.anki21b` and new-format media,
> guid matching, media onto content hashes, `[latex]` counted in the report, and
> review history replayed so FSRS re-derives stability rather than trusting
> Anki's intervals.
>
> The container is ours: `zip.ts` is a reader and writer over the native
> `DecompressionStream`, and the only dependency added in this phase is `fzstd`
> (~8 kB, decompress only) because zstd is the one compressor no browser ships.
> Anki's image-occlusion syntax converts onto our normalised shapes, which needs
> the image measured — an image we cannot measure leaves the field alone and the
> card renders as the bare plate, counted in the report.
>
> The round-trip check runs in `e2e/app.mjs` against real Chrome: export the
> collection, feed the file back through the real file input, and assert nothing
> was duplicated, every note matched on its guid, and the note, card and review
> counts came back unchanged. Finding that last one honest needed a fix — an
> answer this device recorded has a random id, so the log is deduplicated on
> (card, instant) rather than on the id.
>
> Deliberately not done, and why:
>
> - **Export is schema 11**, the legacy format. Every Anki since 2.0 reads it and
>   it needs no zstd *encoder*. Marked `ponytail:` in `anki/write.ts`.
> - **Import runs in the page**, not in a queue — there is no backend to queue
>   it on until Phase 5. It pages through notes and reports progress. **Phase 5
>   adds the server-side job** and keeps this one as the offline path.
> - **The whole archive is held in memory.** Fine to a few hundred megabytes;
>   streaming wants random access to the `File`, which the browser does give us.
>   Marked `ponytail:` in `zip.ts`.
> - **Schema 18 and zstd are unit-tested, not round-tripped** — our own export is
>   schema 11, so that is the path the browser check exercises end to end. The
>   18 path needs a real modern `.apkg` as a fixture.
> - **LaTeX fidelity is now measurable rather than measured**: the importer
>   counts notes using `[latex]`, which is what PHASES asked for before deciding
>   between a render job and a documented limit.

---

## Phase 5 — Laravel backend, auth & sync · ~3.5 weeks

*(+0.5 wk — the router and five screens, which the old estimate did not carry.
+1 wk — moving `.apkg` import to a queued job, decided after Phase 4.)*

- ✅ Laravel scaffold, carried from Phase 0: Sanctum, MySQL, Redis, queue worker,
  Reverb installed.
- ✅ **Auth is decided in PLAN.md §2.6, not here.** Bearer tokens for both
  clients, one per device, sliding 60-day expiry, no cookie mode. Email +
  password now; ◻︎ Google and Apple together when either lands (App Store rule
  4.8).
- ✅ `devices` carries the token *and* that device's sync cursor — same row, so
  revoking a device is one delete.
- ✅ **The invariant: a 401 never takes the collection away.** Sign-in is a state
  (`synced` / `sync paused` / `local only`), never a wall. Expiry queues rows and
  shows one banner. *`SyncBanner` carries the three states and `AccountMenu`
  prints the one in force beside the account it belongs to.*
- ✅ **Router first** (UI.md §6). A reset link has to land on a URL, marketplace
  decks have to be shareable, and Phase 12's universal links must resolve to the
  same paths. Four screens on a `View` union was right; twelve is not. Paths are
  the contract mobile copies. *Built on react-router; every path lives in
  `src/routes/paths.ts` so a rename is a compiler error rather than a dead link
  found in an email months later.*
- ✅ **Auth pages:** sign in · create account · forgot password · reset password.
  Not the front door — reached *from* the deck list, never placed in front of it.
  No email-verification wall; verification gates marketplace publishing only.
- ✅ **The decision that gates them:** signing into account B on a device already
  holding account A's collection. **Settled: always adopt the local rows into the
  account being signed into.** No prompt, nothing destroyed — but a borrowed
  device donates its history to whoever signs in next, which is the cost that was
  accepted knowingly.
- ✅ **Who is signed in is visible from the app chrome**, not only from Settings.
  Name, email and sync state in one glance, because "always adopt the local rows
  into the account being signed into" means a borrowed device donates its
  history — and the person holding it has to be able to see which account is
  about to receive their reviews without navigating to find out.
- ✅ **Settings:** profile · devices (revoke = sign out that phone) · storage
  (per-deck offline opt-in with size estimate) · scheduling defaults ·
  appearance (system/light/dark — there is no toggle today) · data export and
  account deletion. Sign-out counts unsynced reviews before offering to clear
  anything; deletion is a different action and offers `.apkg` export first.
- ✅ **API shape is fixed here, because a phone cannot be force-updated:**
  `/api/v1/`, client-generated UUID keys (⇒ idempotent retries), cursor
  pagination, `{ data, next_cursor, server_time }`, stable string error codes,
  `client_ts` *and* `server_received_at` on every review.
- ✅ The API client lives in `packages/core` — Phase 12 imports it unchanged.
- ✅ Push: batch POST of new `reviews`. Pull: everything since the cursor. No
  merge code — single-writer data cannot conflict. *The loop is `hooks/useSync.ts`
  over `lib/sync.ts`; it reads unsynced rows out of local SQLite and applies
  pulled rows back into it.*
- ⚠️ Deck and note content sync, per-field `updated_at`, last-write-wins.
  *Last-write-wins is **row-level**, not per-field: two offline edits to
  different fields of one note keep only the later note. Marked `ponytail:` in
  `SyncService::push`; per-field needs a `field_updated_at` map on both sides,
  and Phase 9's CRDT is the real answer for genuine co-editing.*
- ✅ **Eager push of unsynced reviews at session end** — Safari evicts storage
  after 7 idle days. *`visibilitychange` in `useSync`.*
- ✅ **Service worker**, carried from Phase 1: app shell and an immutable-asset
  cache. *Hand-written, not Workbox, and `public/sw.js` argues the case: Vite
  already content-hashes every asset, which is the guarantee a precache manifest
  exists to provide. The media cache is deferred with the media transport it
  would cache — see the note at the end of Phase 8.*
- ◻︎ Server-side FSRS for dashboards and parameter optimisation. **Still open**,
  and the only Phase 5 line that is. Nothing downstream blocks on it: the
  dashboard computes from the local log, and optimisation is a Phase 10 concern.
- ✅ **Move `.apkg` import to a queued job**, which is where PLAN.md §1 always put
  it and where Phase 4 could not. Decided after Phase 4 shipped: an import that
  lands in MySQL syncs to *every* device, where a client-side one only ever
  reaches the device that ran it. Upload → queue → unzip → zstd → read → write,
  with the client polling the job rather than holding a websocket.
  - The mapping logic ports to PHP: `ext-zip`, `ext-zstd` and `pdo_sqlite` are
    all present, the protobuf reader is ~60 lines of varint, and
    `getimagesizefromstring` measures an occlusion image without the
    `createImageBitmap` dance the browser needed.
  - **The client importer stays** as the offline path. The browser can import
    signed out and on a plane; the server cannot. Two importers over one mapping
    is a real cost — the fixtures in `packages/core/src/anki/anki.test.ts` are
    what stop them drifting, and the PHP port has to pass the same cases.

**Done when:** two browsers, both offline, both review, both reconnect, no loss —
and signing out and back in never costs a card.

> **Landed so far — the backend half.** Laravel 13 at `apps/api` on MySQL and
> Redis, UUID keys throughout, service + repository structure, 24 tests.
> `packages/core/src/api/` holds the shared client, 12 tests. Nothing in
> `apps/web` has changed yet: the frontend still has no idea an account exists.
>
> Four decisions worth keeping, because none of them is recoverable cheaply
> later:
>
> - **The sync cursor is a per-user revision counter, not a timestamp.** Two rows
>   written in the same millisecond are indistinguishable, and `updated_at` is
>   the client's clock, which §2.6 already says not to trust. One counter per
>   account orders writes across all six tables, so one cursor is enough.
> - **`card_states`, not `cards`.** Rule 1 makes scheduling a derived cache, so
>   syncing `due`/`stability`/`state` would ship a cache over the network and
>   then argue with it. Only what a person *decided* syncs: suspended, buried,
>   flag, deck override.
> - **Tombstones on every syncable table.** A hard delete is invisible to any
>   device that was offline when it happened, and the row comes back on their
>   next push.
> - **Sign out and revoke differ.** Sign out drops the token and keeps the device
>   row and its cursor, so signing back in resumes instead of re-pulling the
>   collection. Revoke removes both.
>
> Two things found by building rather than by review. **Reverb does install** on
> Laravel 13 — the first failure was a partial-update artifact, and `-W` resolves
> it by staying on guzzle 7, which Laravel 13 supports. And a sync test appeared
> to show one account reading another's rows: that was Laravel's auth guard
> memoising the first resolved user within a single test's container, not a
> production leak — but every multi-account test was passing for the wrong
> reason until `TestCase::actingAsToken()` started calling `Auth::forgetGuards()`.

---

## Phase 6 — Dashboard, global card browser & Pomodoro · ~1.5 weeks · ✅

- ✅ **Global card browser** — cross-deck, filters on state / flag / tag / due /
  lapses, and **bulk** suspend, flag, reschedule, retag, move. One of the two
  screens heavy Anki users live in, and it has to exist before the marketplace
  makes collections big.
- ✅ **Hierarchical tag sidebar** (`anatomy::thorax::valves`) and the reserved tags
  — `marked` as a per-note bookmark, `leech` written by the scheduler.
- ✅ Dashboard names **weaknesses**: worst topics by lapse rate, leeches with the
  reason, true vs. target retention, forecast load.
- ✅ Streak, heatmap, time-of-day accuracy.
- ✅ **Leech detection** and **sibling burying** — Anki hides a note's other cards
  once one is answered; the most-noticed missing behaviour on reversed decks.
  *Half-landed until Phase 8's audit: the `bury_new` / `bury_reviews` columns and
  `siblingsToBury`'s options parameter both existed, but `burySiblings` never
  read the columns and no screen ever wrote them — so burying was unconditional
  and the deck option was a setting that did nothing. Wired, and the toggle now
  sits beside desired retention on the deck screen.*
- ✅ **Audio autoplay** with a deck option, which needs the parent to own the audio
  element, the same shape as the type-in box.
- ✅ **Sound feedback on the study loop** — reveal, the four ratings, undo, session
  complete. Off by default, synthesised with WebAudio rather than shipped as
  files, under 80 ms each, and played from the handler that does the reveal so
  it is not late. Same restraint budget as the motion rules; written up in
  [UI.md](UI.md) §3. Distinct from card `[sound:]` media above: that is content,
  this is confirmation that a rating registered while the eyes were on the card.
- ✅ Pomodoro 25/5, offline, logged beside reviews so focus blocks can be correlated
  with accuracy.

**Done when:** it tells you something Anki's stats never did.

---

## Phase 7 — Filtered decks (custom study) · ~1 week · ✅

Cram sessions before an exam — the most-asked-for Anki feature after the
scheduler itself. This is the last comfortable moment: it touches `nextCard`,
`deckTree` and `counts`, and doing that before the marketplace multiplies
collection sizes is cheaper than after.

- ✅ Cards move to a temporary deck and return: `cards.original_deck_id` +
  `original_due`, restored on rebuild or empty.
- ✅ Search-driven (`tag:exam is:due`), with a card limit and an order.
- ✅ **Reschedule or not.** *Decided the third way: with rescheduling off, the
  answer writes **nothing** to the review log and the card goes straight home.
  The log has no "this was a cram" column, and `replayReviews()` re-applies every
  row it finds — so an unflagged row would quietly reschedule the card on the
  next cache rebuild, and a flagged one cannot exist honestly until the column
  does. The cost is that a cram is invisible to the dashboard, and the one-column
  upgrade is marked `ponytail:` at the call site.*

**Done when:** cram a tag, empty the deck, every card is back where it started
with its schedule untouched.

---

## Phase 8 — Public marketplace, cloning & moderation · ~3 weeks · ✅

*(+1 wk — day-one moderation is a product surface, not a checkbox)*

- ✅ Visibility private / unlisted / public. Publishing creates an **immutable
  version** (semver + changelog), never a live pointer. *`listings` holds the
  state, `listing_versions` holds the bytes; a publish always cuts a row.*
- ✅ Clone stores `source_deck_id` + `at_version` ⇒ "update available", merging
  upstream without destroying local scheduling. This is what Phase 3's guids buy.
  *The merge is the install run again: notes are matched on a guid derived from
  the published one, so cards and scheduling survive it. The offer now appears on
  the **deck list**, not only on the listing page — `GET marketplace/updates`
  answers for a whole collection in one request, and it is public, because a deck
  cloned signed out is still a deck whose updates the person is owed.*
- ✅ Browse, search, tags, preview-before-clone, ratings.
  - *Preview renders a real card with the renderer that will render it after
    cloning, and downloads **nothing**: the listing response carries five sample
    notes and their note types, which is everything `paintCard` needs.*
  - *Ratings are one to five stars, **only from accounts that cloned the deck**.
    That rule is the reason the number is worth printing, and it is the cheapest
    anti-brigading measure available: a downvote costs a clone. An unrated deck
    says "not rated yet" rather than drawing an empty five-star row.*
- ✅ **Trust & safety, shipped with it, not after:**
  - ✅ rights attestation at publish time, recorded with the version *(and the
    IP it was attested from)*
  - ✅ report button on every public deck
  - ✅ moderation queue with unlist / take down / approve / dismiss, and an
    append-only audit trail in `listing_moderation_events` — publications,
    removals, counter-notices and reinstatements in the order they happened.
    *The three `moderated_*` columns on `listings` hold only the latest decision;
    a reinstatement used to overwrite the takedown it reversed, which is exactly
    the sequence a counter-notice is argued from.*
  - ✅ counter-notice flow and a published contact. *The publisher's shelf at
    `/explore/mine` is where a removal becomes visible — it is invisible
    everywhere else by design — and the reply is the button beside it. `/legal`
    is public and openable without an account, because the person who needs the
    address usually does not have one.*
  - ✅ rate limits on publishing (5/hr) and reporting (5/hr); new accounts stay
    in `in_review` until a moderator approves their first deck — a status only a
    moderator can move, not a visibility the publisher can flip.
- ⚠️ You are AU-based, so the safe-harbour regime is the Copyright Act 1968, while
  most notices will arrive DMCA-shaped from US users. Both intake paths are
  accepted and `/legal` says so. **Still un-reviewed by anyone qualified, and the
  page says that too. It remains the one item here that code cannot de-risk.**

**Done when:** clone a public deck, upstream ships v2, you merge and keep history
— and a reported deck is down in under a minute with a record of why. *Both hold:
`BrowseTest`, `PublishTest`, `RatingTest` and `ModerationTest` are 33 tests over
the first, and the second is one `POST .../takedown` that flips one column every
distribution path already reads.*

> **The one thing a published deck still cannot carry: its media.** Images and
> audio live in a per-account store with no HTTP path — `mediaUp()` in the sync
> client syncs the *metadata* and says so in a comment, because the bytes have no
> endpoint on either side. So a published anatomy deck arrives without its
> plates, and the app says so in three places rather than letting anyone find out
> after cloning: on the publish screen, on the preview, and on the card.
>
> This is not a marketplace bug. It is Phase 5's deferred media transport, and it
> blocks the medical vertical the whole plan is aimed at, so it is scheduled
> rather than noted: **`POST /media/{sha256}` + `GET /media/{sha256}` for an
> account's own bytes, a sha256 manifest inside each published version, and
> `GET /marketplace/listings/{listing}/versions/{v}/media/{sha}` scoped to that
> version.** Content-addressed, so the service worker caches it with one line
> (`public/sw.js` already reserves the spot). Roughly half a week, and it should
> come before Phase 9 rather than after — Phase 9 adds a second writer to decks
> whose images still do not travel.

---

## Phase 9 — Live collaboration (full co-editing) · ~2 weeks · **← next**

> Preceded by the ~0.5 wk media transport scheduled at the end of Phase 8. Adding
> a second writer to a deck whose images still cannot travel is building on the
> gap rather than closing it.


- Y.Doc per deck; notes as `Y.Map`, rich fields as `Y.Text`.
- Transport **Laravel Reverb**. Laravel stores updates as **opaque binary blobs**
  and rebroadcasts — PHP merges nothing, because Yjs updates are commutative.
- **Materialize** applied updates into local SQLite so study and search keep one
  source of truth. During a session, never write those rows directly.
- **Nightly compaction** `yjs_updates` → `yjs_snapshot`. Skip it and the log
  grows without bound — the piece that bites six months in.
- Presence (avatars, live cursors); roles owner / editor / viewer.
- **Pages:** collaborator list with role change and removal, invite by email,
  pending invites. The mechanism was planned long before the screens were.
- Offline edits queue and merge on reconnect — free, this is what CRDTs are for.

**Done when:** two people type in the same card at once, one on a flaky
connection, nothing is lost, and a third joins mid-session and converges.

---

## Phase 10 — AI card generation & summaries · ~2.5 weeks

- Upload PDF / image / text → queued job → extract (PDF text layer, OCR
  fallback) → chunk → candidate cards.
- **Mandatory approval screen.** Every card is a suggestion until a human accepts
  it. Bad cards compound through FSRS.
- Each generated card cites its source page or region.
- AI summary with **generative UI**: structured JSON bound to a **fixed registry**
  of vetted React components (summary, comparison table, timeline, concept map,
  weak-topic callout). Never model-authored markup.
- Online-only, with an explicit "needs connection" state.

**Done when:** a 40-page PDF yields cards you would actually keep.
**Prototype the generative UI in a day before committing the full phase.**

---

## Phase 11 — Interactive sim cards · ~1 week

Independent of 3D, and the best learning-value-per-line in the plan. Plain TS in
`packages/core`, so React Native inherits it. See `SIMULATION.md`.

- Card kind **Simulation**: parameters → predict → run → compare.
- Ship 3–4 models: 2-element Windkessel, Frank-Starling, Hodgkin-Huxley,
  two-compartment PK. Tens of lines each, forward Euler, no solver dependency.
- Offline by construction — it is arithmetic.

**Done when:** "afterload doubles, predict stroke volume" is a scheduled card
that draws the real curve on reveal.

---

## Phase 12 — React Native mobile · ~3 weeks

- Expo + `packages/core` unchanged. **op-sqlite** locally — *the same SQL and the
  same migrations as web*, which is the payoff for Phase 0.
- Template output into a WebView.
- Offline-first and auth are both inherited, not rebuilt: same bearer tokens,
  same `packages/core` API client, token in Keychain / Keystore instead of local
  SQLite. That is what PLAN.md §2.6 bought.
- Mobile-only work, none of it cheap to retrofit: **Sign in with Apple**
  (mandatory once Google sign-in exists), universal / app links resolving to
  Phase 5's paths, push notifications for study reminders, and resumable media
  upload on a connection that will drop.

---

## Later, deliberately

| | Why it waits |
|---|---|
| Polygon drawing in the occlusion editor | Renders and imports already. Drawing needs click-to-place vertices and escape-to-finish; a rectangle is what people draw over a plate. |
| Video capture | The media pipeline is mime-agnostic; only the capture UI is missing. |
| `{{tts}}`, furigana / kana / kanji | Not this audience. Ship when someone asks. |
| Deck options presets | Anki shares one options group across decks. We keep one number per deck, not thirty. |
| Per-note-type CSS and template editing | Behind "Advanced" forever. PLAN.md §3: fixed kinds for normal users is the product. |

---

## Post-launch — Medical 3D vertical · ~2 weeks

Deferred by decision. When you pick it up:

- Fork [`human-atlas`](https://github.com/ashemag/human-atlas) — MIT code,
  CC BY 4.0 data, already React + Three.js + shadcn, 2,234 selectable meshes.
- Card kind **3D Structure**: camera pose + highlighted mesh ⇒ "name this", or
  prompt ⇒ "click this structure". FSRS-scheduled like any other card.
- Orbit / zoom / isolate / explode / layer toggles; click-to-pick.
- Assets behind per-deck offline opt-in; lazy-load by system layer.
- Keep the DBCLS attribution string visible (see `ASSETS-3D.md`).
- Baked glTF animations for beating heart / breathing lungs — no physics engine.
- Real PhysioNet ECG strips (ODC-BY) for rhythm-recognition decks.

**The cost of deferring:** this is the clearest differentiator and the reason a
medical student would switch. Phases 0–11 ship a very good general flashcard app
into a crowded field. Pull it forward the moment a medical cohort shows interest.

---

## Timeline

| | Phases | Weeks | |
|---|---|---|---|
| Storage, study loop, card engine | 0–2 | 6 | ✅ done |
| Decks, authoring, Anki engine | 3 | 2 | ✅ done |
| Import & export | 4 | 2 | ✅ done |
| Accounts, auth pages, sync, server-side import | 5 | 3.5 | ← in progress |
| Dashboard + card browser | 6 | 1.5 | |
| Filtered decks | 7 | 1 | |
| Marketplace | 8 | 3 | |
| Collaboration | 9 | 2 | |
| AI | 10 | 2.5 | |
| Sim cards | 11 | 1 | |
| **Web launch-ready** | **0–11** | **~24.5** | ~14.5 remaining |
| Mobile | 12 | 3 | |

The old table said ~19 weeks to launch. It did not carry deck creation, the
authoring loop, note GUIDs, note-type management, the router, the auth pages,
Settings, the global card browser or filtered decks — all of which are either
required by something already planned or are the reason someone opens the app.
~23.5 is the number with them in it.

**Ordering rationale:** 2 before 3 (the engine is what authoring edits) · 3
before 4 (import depends on guids, deck override, note-type management and the
`::` mapping) · 5 before 8 and 9 (both need accounts) · 6 and 7 are deliberate
cheap wins between two hard phases · 10 and 11 are independent of each other and
of 3D, swap freely.
