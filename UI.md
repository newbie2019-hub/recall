# UI direction & shadcn component map

---

## 0. The trap in "use shadcn as much as possible"

shadcn is the right call — you get Radix behaviour, keyboard handling, focus
management and ARIA for free, as copied source you own, with no runtime
dependency to fight later.

But shadcn's *defaults* are the single most recognizable look on the web right
now: zinc neutrals, `--radius: 0.5rem`, Inter, a faint border and a faint shadow.
Ship those and the app reads as generic regardless of how good the product is.

**These are separable.** shadcn components are unstyled Radix behaviour wired to
CSS custom properties. Every component reads `--background`, `--foreground`,
`--primary`, `--muted`, `--border`, `--radius` from `:root`. Replace that token
block and every component changes at once, with zero component edits.

So: **use shadcn for ~95% of the UI, and own the token layer, the type, and three
custom pieces.** That is the whole strategy.

---

## 1. Direction: "specimen label"

A flashcard *is* a specimen label — a thing and its name. That is also what an
anatomical plate is, what a museum catalog card is, what a slide label is. The
audience already lives in that world.

This beats the two obvious alternatives: the *anatomical-plate* route (cream +
serif + terracotta) and the *patient-monitor* route (near-black + acid green) are
both templated AI-design defaults that would arrive regardless of the brief.

### Palette — from H&E staining

Hematoxylin stains nuclei blue-violet, eosin stains cytoplasm pink. Every medical
student has stared at that pair for hours. It is instantly legible to the
audience, carries real meaning, and is not in use by any flashcard app.

**Light — "bench"**
| Token | Hex | Role |
|---|---|---|
| `--paper` | `#F4F2ED` | ground, archival card stock |
| `--ink` | `#1C1A17` | text, warm iron-gall black |
| `--ink-muted` | `#6B655C` | secondary text, labels |
| `--rule` | `#DCD7CD` | hairlines, borders |
| `--hematoxylin` | `#4A3D8F` | structure, navigation, "known" |
| `--eosin` | `#C75F7D` | attention, due counts, "needs work" |

**Dark — "night bench"** (most study happens at night; this is not an afterthought)
| Token | Hex |
|---|---|
| `--paper` | `#17161C` — violet-tinged charcoal, never `#000` |
| `--ink` | `#E8E4DC` |
| `--ink-muted` | `#918B83` |
| `--rule` | `#2A2833` |
| `--hematoxylin` | `#9B8FE8` |
| `--eosin` | `#E4899F` |

### Answer buttons — do not use a traffic light

Again / Hard / Good / Easy is the most-pressed control in the app; a heavy user
hits it tens of thousands of times. Red-amber-green is the obvious choice and it
is wrong twice: **~8% of males have red-green colour deficiency** (an accessibility
failure that a medical audience will notice), and hue alone is a weak signal at
speed.

Instead: **Again** is filled `--eosin` — semantically the odd one out, the stain
that marks what needs attention. **Hard / Good / Easy** are a single-hue
`--hematoxylin` luminance ramp, light to saturated. Distinguishable by luminance,
position, shape and label — colour is reinforcement, never the carrier. Keys 1–4
always shown.

### Type

| Role | Face | Scope |
|---|---|---|
| Display | **Bodoni Moda** | Wordmark and the dashboard's hero numerals. **Nothing else.** |
| Card content | **Literata** | Built for sustained reading; real italics for Latin nomenclature |
| UI chrome | **IBM Plex Sans** | Labels, buttons, navigation |
| Data | **IBM Plex Mono** | Intervals, counts, catalog IDs, FMA codes |

Bodoni is the deliberate risk: anatomical copperplate engraving *is* high-contrast
Didone, so the reference is earned rather than decorative. It is also easy to
overuse — hence the hard scope limit. That is the one accessory; everything else
stays quiet.

### `--radius: 0.125rem`

Near-square. This single token does more to shed the default shadcn look than any
other change, and it suits card stock and catalog tags.

---

## 2. Signature: the specimen tag

Every card is framed as a specimen tag — the one element the app is remembered by,
and it appears everywhere without competing with content.

- Hairline **double rule** border (`--rule`), no shadow, near-zero radius.
- **Notched top-left corner** via `clip-path` — a tag, not a rectangle.
- **Catalog number** top-right in Plex Mono: the real card ID, or the **FMA ID**
  for anatomy cards. Structure encoding information, not decoration.
- **Taxonomic path** bottom-left in small-caps Plex Sans: `Anatomy · Thorax · Heart`.

~20 lines of CSS. Used on the review card, marketplace tiles and the authoring
preview, so the whole app coheres from one device.

---

## 3. Layout: the review screen is the emptiest screen

90% of time-in-app is review. Everything that is not the card is a distraction.

```
┌──────────────────────────────────────────────┐
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░   47 / 180   ⋯   │  ← Progress + count + card menu
├──────────────────────────────────────────────┤
│                                              │
│      ╭─────────────────────────────╮         │
│      │╭───────────────────  FMA7088│         │  ← notched corner, catalog no.
│      ││                            │         │
│      ││   Which valve prevents     │         │
│      ││   backflow into the left   │         │  ← Literata, ~60ch measure
│      ││   atrium?                  │         │
│      ││                            │         │
│      ││ ANATOMY · THORAX · HEART   │         │  ← taxonomic path
│      │╰────────────────────────────│         │
│      ╰─────────────────────────────╯         │
│                                              │
├──────────────────────────────────────────────┤
│   [1 Again]  [2 Hard]  [3 Good]  [4 Easy]    │  ← pinned, thumb + key reach
└──────────────────────────────────────────────┘
```

No sidebar, no deck tree, no chrome during review. Everything else is one
keystroke away and zero pixels present.

### Motion: one moment only

The reveal is a **120 ms cross-dissolve plus a 2px rise**. That is the entire
motion budget for the review loop.

Explicitly rejected: the 3D card flip. It is the flashcard cliché, it costs
300–500 ms per card, and at 200 cards a day it is actively unpleasant. Restraint
here is the design decision, not an omission. `prefers-reduced-motion` drops even
the dissolve.

---

## 4. Component map

### Review
| Need | Component |
|---|---|
| Session progress | `Progress` |
| Answer buttons | `Button` — custom `cva` variants, still shadcn |
| Keyboard hints | `Tooltip` |
| Undo | `Sonner` toast |
| Card actions (suspend / bury / flag / edit) | `DropdownMenu` |
| Edit mid-review | `Dialog` |
| Card stats & history | `Sheet` |
| **Custom** | tag frame, reveal transition |

### Deck browser (nested decks)
| Need | Component |
|---|---|
| Deck tree | `Sidebar` block + **`Collapsible`** (arbitrary depth — not `Accordion`) |
| Due / new / learning counts | `Badge` ×3 |
| Right-click deck ops | `ContextMenu` |
| Current path | `Breadcrumb` |
| Jump to deck (⌘K) | `Command` — highest-leverage component in the app |
| Rename / move / options | `DropdownMenu`, `Dialog` |
| Delete | `AlertDialog` |
| Loading | `Skeleton` |

### Authoring
| Need | Component |
|---|---|
| Fields | `Form` + `Input` + `Textarea` + `Label` (react-hook-form + zod) |
| Note type | `Select` |
| Front / Back / Styling | `Tabs` |
| Formatting | `ToggleGroup` |
| LaTeX & media insert | `Popover` |
| Tags | `Combobox` |
| Editor / preview split | `Resizable` |
| Sticky fields | `Switch` |
| Template field reference | `HoverCard` |
| **Custom** | cloze toolbar, image-occlusion canvas (2D canvas), sandboxed preview iframe |

## 4.5 As built (Phases 0–2)

The map above is the plan. What shipped diverged in four places, and each
divergence has a reason worth keeping:

| Planned | Built | Why |
|---|---|---|
| Image occlusion on a **2D canvas** | **SVG** overlay, normalised 0–1 coordinates | The card renders in a script-less iframe, so there is no JS in there to drive a canvas. SVG needs none, and normalised coordinates survive the image being re-encoded. |
| Authoring fields as `Input` + `Textarea` + `Form` + zod | `contentEditable` + `execCommand`, no form library | Card fields hold HTML, not strings. A schema validator over a field whose only rule is "renders to something" earns nothing. |
| Deck tree as `Sidebar` + `Collapsible` | Flat indented list from one recursive CTE | Five decks do not need a collapsible sidebar. Revisit at the depth where scrolling hurts, not before. |
| Reveal as a **cross-dissolve on one surface** | Two frames stacked in one grid cell, dissolving between | Same 120 ms, but the card box sizes to the *taller* side, so revealing never jumps the layout — the thing that actually annoys people in Anki. |
| Desired-retention **slider** | Four-item `Select` (85 / 90 / 93 / 95%), each labelled with what it costs | A slider promises precision the number does not have — 0.87 and 0.88 are the same decision. Naming the trade-off ("fewer reviews" / "exam week") is the thing being chosen. |

New surfaces this phase, and the components behind them:

| Screen | shadcn | Custom |
|---|---|---|
| Deck browser | `Input` (search + new/day), `Select` (retention), `Badge`, `Button`, `Label` | — |
| Note editor | `Select` ×2, `Label`, `Input`, `Separator`, `Button` | field boxes, toolbar, ord switcher |
| Occlusion editor | `Select`, `Button`, `Label` | drag-to-draw SVG surface |
| Card frame | — | sandboxed iframe + injected palette |

**Card content styling is not shadcn's job and must not become it.** The
stylesheet inside the frame is ~70 lines and is written against the card's own
vocabulary — `.cloze`, `.cloze-blank`, `.typed-missing`, `.io-mask` — with the
palette injected from the host so it tracks the theme. It reuses the specimen
tag's double hairline as the question/answer divider, and masks are paper-coloured
label stickers rather than black boxes, which is the whole H&E idea applied to
a plate.

---

### Dashboard
| Need | Component |
|---|---|
| Retention, forecast, heatmap | **`Chart`** (shadcn's Recharts wrapper) |
| Stat tiles | `Card` — hero numeral in Bodoni |
| Time range | `Tabs` or `ToggleGroup` |
| Leeches & weak topics | `DataTable` (sortable) |
| Grouping | `Separator`, `Badge` |

> Charts must follow the `dataviz` skill, not Recharts defaults — same trap as
> shadcn defaults, one layer down.

### Marketplace
`Card` grid · `Command` + `Input` search · `ToggleGroup`/`Select` filters ·
`Pagination` · `Avatar` authors · `Dialog` preview-before-clone · `AlertDialog`
report · `Badge` version and tags · `HoverCard` deck stats on hover.

### 3D viewer
`Resizable` canvas/structure split · `ScrollArea` structure tree · `Slider`
opacity and explode · `ToggleGroup` system layers · `Command` FMA structure search
· `HoverCard` on mesh hover · `Toggle` isolate. **Custom:** the Three.js canvas.

### Collaboration · Pomodoro
`Avatar` presence (custom stack) · `Badge` roles · `Sonner` join/leave ·
`Progress` or custom ring · `Popover` settings · `Drawer` on mobile.

### Account & auth

Four pages, and they are **not the front door**. PLAN.md §2.6 fixes the rule —
*a 401 must never take the collection away* — so these are reached *from* the
deck list, never placed in front of it. That inverts the usual SaaS flow and it
changes every one of these screens:

| Screen | Component | The thing that is different here |
|---|---|---|
| Sign in | `Card` + `Form` + `Input` + `Button` | Says what it does to local data: *"Your cards stay on this device either way."* Failure is a field error, never a redirect. |
| Create account | same | No email-verification wall. Unverified accounts sync; verification only gates publishing to the marketplace (Phase 8). |
| Forgot password | `Form` + `Input` | Laravel signed URL. The mail link must open the **web** app even when tapped on a phone — universal links, Phase 12. |
| Reset password | `Form` + `Input` ×2 | Signed-URL landing. Reachable signed-out, and signed-in with an expired token. |
| **Signed-in elsewhere** | `AlertDialog` | The case most apps get wrong: signing into account B on a device already holding account A's local collection. **Decide it before writing the page** — the options are upload-local-into-B, keep-both-and-switch, or refuse until the local rows are synced or exported. Silent overwrite is the one answer that is not allowed. |

Sign-out is a `AlertDialog`, not a page, and it must count unsynced `reviews`
before it offers to clear anything. Account deletion is a *different* action
with a different dialog, and it offers `.apkg` export first.

### Settings

| Section | Component | Notes |
|---|---|---|
| Profile | `Form`, `Avatar` | Name, email, password change. |
| Devices | `DataTable` + `AlertDialog` | One row per token (PLAN.md §2.6). Revoking signs out exactly that phone. Shows last-seen and sync cursor age. |
| Storage | `Switch` per deck, `Progress` | Per-deck offline opt-in with size estimate, plus "what is on this device". Named once in a sync bullet and never designed — this is its design. Phase 5. |
| Scheduling defaults | `Select`, `Input` | Retention and new/day applied to **newly created** decks. Per-deck values already live in the deck browser. |
| Appearance | `ToggleGroup` | System / light / dark. Currently the app reads `prefers-color-scheme` once at boot and offers no toggle — §6 promised one. |
| Data | `Button`, `AlertDialog` | Export `.apkg`, import, delete account. |

### Deck management · Global card browser

Two homes that do not exist yet and are not the deck's options row:

| Screen | Component | Why it is its own surface |
|---|---|---|
| Deck menu (rename / move / delete / publish / share) | `DropdownMenu` + `Dialog` + `AlertDialog` | Already in the deck-browser map above as context actions; deck create/rename/move/delete is Phase 3; publishing (Phase 8) and collaborators (Phase 9) hang off the same menu. |
| Collaborators | `DataTable` + `Select` (role) + `Dialog` (invite) | Phase 9 plans the *mechanism* — Y.Doc, Reverb, presence, owner/editor/viewer — and no pages. Invite by email, pending invites, role change, remove. |
| **Global card browser** | `DataTable` + `Command` + faceted filters | The real gap. `Browse.tsx` lists notes in one deck. Anki's Browse is cross-deck, filters on state / flag / tag / due / lapses, and does **bulk** suspend, flag, reschedule, retag and move. It is one of the two screens heavy users live in, and it appears in no phase. |

## 4.9 Every screen, and the phase that builds it

| Screen | Phase | State |
|---|---|---|
| Deck list · Study · Deck browser · Note editor | 1–2 | **Built** |
| Deck options (retention, new/day) | 1 | **Built** — inline in the deck browser, never planned as a screen |
| **Create / rename / move / delete a deck** | 3 | **Missing entirely** — no user can make a deck today |
| Add-card flow at volume (⌘↵, sticky fields, paste, tags) | 3 | CARDS.md §1 |
| Note-type management · change note type | 3 | CARDS.md §7 |
| Import / export `.apkg` | 4 | PHASES §4 |
| Sign in · Create account · Forgot · Reset | 5 | Planned in §4 above |
| Settings (profile / devices / storage / defaults / appearance / data) | 5 | Planned in §4 above |
| Dashboard | 6 | Planned (§4) |
| **Global card browser** | 6 | Was unscheduled until a screen audit found it |
| Filtered decks / custom study | 7 | PHASES §7 |
| Marketplace · deck detail · publish · moderation queue | 8 | Planned (§4) |
| Collaborators · invite | 9 | **Mechanism was planned; pages are planned in §4 above** |
| 3D viewer | post-launch | Planned (§4, ASSETS-3D.md) |

---

## 5. What shadcn should *not* do

Honest list, so "as much as possible" stays meaningful:

1. **The card renderer.** Imported Anki cards carry untrusted HTML and CSS and
   render in a sandboxed iframe. Nothing inside it is yours to style.
2. **The Three.js canvas.** shadcn owns the chrome around it.
3. **The image-occlusion editor.** Shape drawing on a 2D canvas.
4. **The specimen tag frame.** ~20 lines of CSS.
5. **The rating buttons' *variants*** — but these are `Button` with added `cva`
   variants, which is the intended extension path, not an escape from it.

Everything else is stock shadcn on your tokens.

---

## 6. Implementation notes

- Tailwind v4: define the palette in the `@theme` block; keep shadcn's semantic
  token names (`--background`, `--primary`, …) mapped onto the H&E palette so
  every component inherits without edits. Add `--hematoxylin` / `--eosin` as extra
  tokens for the pieces that need them directly.
- Dark mode: `.dark` class on `<html>`, toggle persisted to localStorage. Vite,
  not Next — no `next-themes`. *As built: the class is set once at boot from
  `prefers-color-scheme` and there is no toggle yet — it belongs to Settings ·
  Appearance, Phase 5.*
- **Routing: none until Phase 5, then a real router.** Four screens are a
  discriminated union in `App.tsx` and that is correct for four screens. It stops
  being correct at the auth pages, because three separate things then need real
  URLs: a password-reset link has to land somewhere, marketplace decks have to be
  shareable (Phase 8), and Phase 12's universal links have to map a URL to the
  same screen on the phone. Adopt the router **at the start of Phase 5, before
  the auth pages**, so those pages are the first ones written against it rather
  than the first ones migrated onto it. Paths are the contract the mobile app
  copies: `/decks/:id`, `/decks/:id/study`, `/notes/:id`, `/browse`,
  `/settings/:section`, `/sign-in`, `/reset/:token`, `/m/:deckId`.
- Self-host the four faces (`@fontsource`), subset Bodoni Moda aggressively; it
  is used for a wordmark and some numerals.
- Quality floor, unannounced: visible keyboard focus everywhere, `1`–`4` and
  `space` bound in review, full keyboard deck navigation, `prefers-reduced-motion`
  honoured, and a review screen that works at 400px.
- Copy rule: actions keep one name through a flow. "Publish" produces "Published."
  Empty decks invite an action rather than apologize.
