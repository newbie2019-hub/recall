# Self-critique of the plan

Scored against the stated criteria, with the four locked decisions folded in.
A self-review that scores itself 10 everywhere is worthless, so the gaps below
are real and the score reflects them.

---

## Decisions taken, and what each one costs

| Decision | What it buys | What it costs | Mitigation in the plan |
|---|---|---|---|
| **SQLite WASM + OPFS** over Dexie | Real SQL; nested-deck recursive CTEs identical to MySQL; *the same SQL reused in React Native via op-sqlite* — this makes the mobile phase cheap | +0.5 wk setup; DB must live in a worker; `opfs-sahpool` allows only one connection | SharedWorker owns the connection, tabs proxy over MessagePort; Web Locks leader election where SharedWorker is absent (Chrome Android) |
| **Full simultaneous co-editing** over comments-only | The impressive demo; genuine study-group wedge Anki has no answer to | +~1.5 wk over the cheap option; unbounded update log; PHP can never merge or validate | Yjs blobs + nightly snapshot compaction; materialize into SQLite on apply; roles limit who can write |
| **Public marketplace + day-one moderation** | The gap I scored lowest is now closed in scope rather than deferred into a surprise | +1 wk; ongoing human moderation load forever after | Rights attestation, report button, moderation queue with audit trail, counter-notice path, publish rate limits |
| **Defer 3D to post-launch** | 2 weeks earlier launch; validates the core product before the vertical bet | **Ships your clearest differentiator last** | Held as a documented post-launch phase, not dropped; pull forward on first medical-cohort interest |

Three of four chose the higher-risk option. That is a legitimate call for a
product that needs to be distinctive — but it front-loads roughly 2.5 extra weeks
and a permanent moderation duty, and it delays the one feature nobody else has.

---

## Scorecard

| # | Criterion | How the plan answers it | Score | Remaining gap |
|---|---|---|---|---|
| 1 | Offline first | SQLite WASM on OPFS via `opfs-sahpool` in a SharedWorker; append-only review log; sync additive, never authoritative; per-deck media opt-in so "offline" stays truthful at GB scale | **10** | — |
| 2 | Laravel backend | Owns auth, marketplace, queues, import, Reverb. Deliberately *not* the sync engine | **10** | Review-log pull needs cursor pagination + queue batching past ~10k users |
| 3 | Live collaboration | Yjs CRDT, Reverb transport, opaque blobs server-side, materialized into local SQLite | **9** | PHP cannot merge Yjs ⇒ **no server-side content validation of collab edits**; anti-vandalism in shared decks is client-side and role-based only. Compaction is mandatory, not optional |
| 4 | Marketplace + clone | Immutable versioned publishes; clones track `source@version` and merge upstream without losing scheduling; moderation shipped with it | **9** | Moderation is a permanent human cost, not a feature you finish. Needs qualified legal review before public launch — code cannot de-risk this one. **Built now, and the honest score is lower until media travels: a published anatomy deck arrives with no plates** |
| 5 | PDF / text / image → cards | Queued extract → LLM → **mandatory approval**, each card citing its source region | **9.5** | OCR on scanned/handwritten material is unreliable; approval UX must make rejection fast or users rubber-stamp garbage |
| 6 | Medical 3D | human-atlas fork fully designed — camera-pose card kind, click-to-pick, FSRS-scheduled — but **post-launch** | **9** | Design is sound; *delivery* is deferred, so v1 does not serve the medical priority you named |
| 7 | Anki import | zstd → SQLite v18, media rewrite, **history replayed** so FSRS re-derives state; export too | **9.5** | Decks exported without full history lose fidelity — the data isn't in the file |
| 8 | LaTeX / math | KaTeX primary, MathJax lazy fallback, Anki delimiters mapped | **10** | — |
| 9 | Progress dashboard | Weakness-first, not volume; pomodoro blocks correlated with accuracy | **10** | — |
| 10 | Anki fidelity (nested/custom decks, audio/image/text/latex) | `parent_id` tree with recursive CTEs; content-addressed media; two-tier note types | **9.5** | Add-on-dependent note types and templates with custom JS won't all work. ~95%, not 100% |
| 11 | Anki card types | All six stock types native; the generation rule + template language covers custom types; golden files before the renderer | **9.5** | Long tail deferred: furigana/kana filters, per-template deck override, browser-appearance templates |
| 12 | AI summary, generative UI | Structured JSON bound to a fixed registry of vetted components; never model-authored markup | **8.5** | Still the vaguest item in the brief. The registry makes it *safe*; nothing yet makes it *useful* |
| 13 | Pomodoro | Offline, logged beside reviews so it feeds the dashboard instead of floating as a gimmick | **10** | — |
| 14 | Stack + RN path | React + TS + Three.js + shadcn now; `packages/core` carries schema, SQL, FSRS and renderer to RN | **10** | 3D is the one part core won't carry cleanly to RN. Budgeted |

**Average: 133.5 / 14 = 9.5**

---

## The honest 0.5

Four things keep this off a 10. None is fixed by better code:

1. **Marketplace liability.** The moment strangers upload medical decks you are a
   content host, and medical decks are full of copyrighted textbook figures.
   Moderation is now in scope, which is the right call — but it is a permanent
   operational cost and it needs real legal review, not a plan file.
2. **Generative UI is a solution looking for a problem.** Every other item has a
   clear user story. Prototype it in a day before spending 2.5 weeks.
3. **No server-side truth for collaborative content.** Choosing full co-editing
   means PHP holds opaque blobs it cannot inspect. Roles and client validation
   are the only guard. Acceptable for study groups; not for open public editing.
4. **The brief contains a contradiction.** "Support Anki very well" and "better
   than Anki" pull opposite ways — Anki's complexity *is* its fidelity. The
   two-tier note-type design resolves it on paper; the failure mode is shipping
   Anki-with-extra-steps. Guard rail: **if a new user must see a card template
   to accomplish something, that is a bug.**

---

## If velocity matters later

Phases 0–6 is a real product in ~15.5 weeks (renumbered — see PHASES.md): offline-first, full Anki card-type
fidelity, imports your existing decks, better dashboard, pomodoro. Marketplace,
collaboration and AI are the three most expensive phases and the three least
proven. You have chosen to build all of them — that is a coherent bet on
differentiation, just make it knowingly.

---

## Post-build addendum — Phase 8, written after it shipped

The scores above judged a plan. These judge the code, and the difference is the
point of writing them down.

**What the build got right.** The two rules the marketplace turns on are
structural rather than promised. A takedown writes one `status` column that
browse, the listing page and the download all read through one scope, so the
three stop together; and there is no code path by which a publisher writes into
a cloned collection, because the clone is the cloner's own local write and the
server only ever learns the deck id. Neither is a rule someone has to remember.

**What the build got wrong, found by auditing it rather than by review.** Three
things, all the same shape — *the server half landed and the client half did
not*, and the tests passed anyway:

1. **The marketplace was unreachable.** Every screen existed, every route was
   registered, and nothing in the app linked to `/explore`, to publishing, or to
   the moderation queue. A feature nobody can navigate to is a feature nobody
   has, and it had been that way for a whole commit.
2. **The preview said "published without a preview" on every deck.** The server
   had been changed to send `preview: {notes, note_types}`; the client still
   read it as an array, found no `.length`, and fell back to downloading the
   entire version — the exact cost the server change existed to remove. The API
   test asserted `assertCount(2, 'preview')` and passed, because the object has
   two keys.
3. **Browse tiles printed no note count or size**, for the same reason: the
   server moved them beside the listing, the tile still looked inside
   `versions`.

The lesson is not "write more tests". It is that a contract change needs one
test that reads the shape it actually produces — `preview.notes` rather than
`preview`. All three are fixed, and the assertions now name the fields.

**A fourth, from a different phase entirely.** The browser suite had one failing
check for "the restored card kept its schedule". It was not the marketplace's,
and it was not a stale test: `burySiblings` never read the `bury_new` /
`bury_reviews` columns, so sibling burying was unconditional and a deck option
that had shipped in Phase 6 did nothing at all. The reverse card was therefore
never studied, had no history to replay, and came back as new — correct
behaviour from an incorrect setting. Wired, with the toggle now on the deck
screen.

**What is still wrong, and named rather than buried.**

- **Published decks carry no media.** The bytes have no HTTP path in either
  direction. This is Phase 5's deferral surfacing in Phase 8, and it is the
  single largest gap in the product, because the vertical this plan is aimed at
  is images. It is now scheduled with a design, not noted. Until then the app
  says so in three places instead of letting people discover it after cloning.
- **The legal wording has not been near a lawyer.** `/legal` states both intake
  paths and says plainly that it is not legal advice. That is the honest version
  of an item code cannot close.
- **The moderation queue is offset-paged and unassigned.** Fine at zero decks,
  wrong the first week two moderators work it at once. Marked `ponytail:`.
- **Search is `LIKE '%term%'` over three columns.** Correct and unindexed;
  `FULLTEXT` is a migration away, and the note about the SQLite test suite is at
  the call site.

**Score for the marketplace as built: 9.5**, and it is 9.5 rather than 10 for one
reason — media. Everything else on the list is either scheduled with a design or
a deliberate, documented trade with a named upgrade path. A deck of text merges
across versions, keeps its scheduling, can be rated only by people who studied
it, and can be taken down in one request with a record that survives the appeal.
A deck of plates arrives blank, and no amount of moderation polish changes that.
