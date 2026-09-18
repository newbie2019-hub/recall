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
| 4 | Marketplace + clone | Immutable versioned publishes; clones track `source@version` and merge upstream without losing scheduling; moderation shipped with it | **9** | Moderation is a permanent human cost, not a feature you finish. Needs qualified legal review before public launch — code cannot de-risk this one |
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
