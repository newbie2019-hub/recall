# Recall

Offline-first spaced repetition. Web app now (React + TS + Tailwind v4 +
shadcn/ui), React Native later off the same `packages/core`.

Planning docs: [PLAN.md](PLAN.md) · [PHASES.md](PHASES.md) · [UI.md](UI.md) ·
[CARDS.md](CARDS.md) · [CRITIQUE.md](CRITIQUE.md) · [ASSETS-3D.md](ASSETS-3D.md) ·
[SIMULATION.md](SIMULATION.md)

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

Phases 0–2 complete: storage spine, offline study loop, and the full note/card
type engine with authoring.

Next: **Phase 3 — decks, authoring at volume and the engine Anki needs.** You
cannot create a deck yet, and adding twenty cards costs twenty navigations; note
GUIDs, deck override and note-type management all have to land before Phase 4's
importer can be correct. See [PHASES.md](PHASES.md) and [CARDS.md](CARDS.md).
