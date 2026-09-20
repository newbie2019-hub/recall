# Recall

Offline-first spaced repetition. Web app now (React + TS + Tailwind v4 +
shadcn/ui), React Native later off the same `packages/core`.

Planning docs: [PLAN.md](PLAN.md) · [PHASES.md](PHASES.md) · [UI.md](UI.md) ·
[CARDS.md](CARDS.md) · [CRITIQUE.md](CRITIQUE.md) · [AI.md](AI.md) ·
[ASSETS-3D.md](ASSETS-3D.md) · [SIMULATION.md](SIMULATION.md)

## Run it

```bash
pnpm install
pnpm dev                       # http://localhost:5173
```

## Check it

```bash
pnpm --filter @recall/core test   # scheduler, replay, template fixtures
pnpm --filter @recall/web build
pnpm --filter @recall/web exec vite preview --port 4173 &
pnpm --filter @recall/web e2e     # drives real Chrome
```

The browser test needs real Chrome: OPFS does not exist in jsdom, and card
content lives inside sandboxed iframes that only a real browser will render.
Override the binary with `CHROME=/path/to/chrome`.

## Layout

```
packages/core     no DOM, no React. Schema, FSRS wrapper, replay, and the whole
                  template engine — template/cloze/occlusion/diff/math. RN reuses this.
apps/web/src/db   worker.ts (owns SQLite), client.ts (RPC), repo.ts (queries)
apps/web/src/lib  media.ts (content-addressed store), render.ts (core → HTML)
apps/web/src      App.tsx, components/{Review,Browse,NoteEditor,OcclusionEditor,CardFrame}.tsx
apps/web/src/lib/collab  doc.ts (the Y.Doc shape), provider.ts (queue + socket),
                  materialize.ts (document → SQLite), transport.ts, echo.ts
apps/api/app      Services/{Anki,Auth,Sync,Marketplace,Collaboration}/
```

## Five rules the rest depends on

1. **`reviews` is append-only.** Never `UPDATE`, never `DELETE`. Scheduling state
   in `cards` is a derived cache — `replayReviews()` rebuilds it from the log.
   Sync, Anki history import and FSRS optimisation all lean on this.
   The single exception is undo, which drops a review that has never synced.
2. **Card ids are `<note id>:<ord>`, not random.** That is what lets a card come
   back: empty an `{{#Add Reverse}}` field and its card is deleted, refill it and
   the same id finds its own rows in the log and replays them. Anki orphans those
   cards; here there is nothing to orphan.
3. **Decks are a `parent_id` tree.** Nesting and rolled-up counts are one
   recursive CTE — the query that made SQLite worth it over IndexedDB.
4. **A count is a promise.** The deck badge, the session counter and the card
   the study loop actually hands over come from one query with one set of
   filters. A deck that says "3 due" and then says "nothing due" is worse than
   a deck that says nothing.
5. **Card HTML is untrusted and renders in a script-less iframe.** No
   `allow-scripts`, ever. Everything else follows from it: KaTeX renders in the
   parent, `{{hint:}}` compiles to `<details>`, occlusion is SVG not canvas, and
   the type-in box is a React control outside the frame.

## Status

Phases 0–9 complete: the storage spine, the offline study loop, the note and
card type engine, Anki import and export, the Laravel backend with auth and
sync, the dashboard and card browser, filtered decks, the public marketplace
with day-one moderation, and live co-editing over Reverb.

**An account is now required.** A fresh browser lands on sign-in, then on a
six-question welcome survey. What has not changed is the rule underneath it: a
*failed* sign-in is never a wall. The guard asks whether this browser has ever
held a confirmed session, so an expired token or a dead network leaves you
studying with the banner showing `sync paused`. Only signing out puts the wall
back. `/explore`, a listing and `/legal` stay open to anyone — a shared deck is
handed to people who do not have an account yet.

**The media transport has landed**, four phases after the metadata started
syncing without it: `PUT`/`GET /media/{sha256}` for an account's own bytes, and
a sha256 manifest inside each published version served by a version-scoped
route. A deck of anatomy plates now clones with its plates. The manifest is
also the authorization list — a published version serves exactly the files it
names, so publishing one deck is not a read of the publisher's library.

**Phase 10 has landed**, designed in [AI.md](AI.md): the AI meter first and the
features after it, so nothing is untracked. A lapse explainer, a **card doctor**
that audits cards you already have, a generation pipeline whose grading pass
throws away what will not survive review, and a weakness briefing over the
dashboard's own figures. All of it off by default. Next: Phase 11, interactive
sim cards. See [PHASES.md](PHASES.md),
[PLAN.md](PLAN.md) and [CRITIQUE.md](CRITIQUE.md), which scores the build rather
than the plan.
