# Adding cards, and every Anki card type

The reference for the authoring surface and for Anki fidelity. PLAN.md §3.5 is
the summary; this is the working document.

**Status key:** ✅ built · ◐ partial · ○ planned · ✗ deliberately not doing.

---

## 0. The one rule everything hangs off

A **note** holds named fields. A **note type** owns N **card templates**. Each
template whose rendered front differs from the same template rendered against a
blank note produces one **card**.

Every stock type, every imported type and every custom type is templates over
that rule. There is no per-type special case in the renderer — cloze and image
occlusion only differ in *where the ordinals come from*: cloze scans every field
of the note for `{{c<N>::…}}`, occlusion reads a shape list, and standard types
count templates.

Two consequences that are ours, not Anki's:

- **Card ids are `<note id>:<ord>`, not random.** Empty `{{#Add Reverse}}` and
  card 2 is deleted; refill it and the same id finds its own rows in the
  append-only review log and replays them. Anki orphans those cards and leaves
  them in a "no template" limbo. Here there is nothing to orphan.
- **Emptiness is Anki's rule, not a tag strip.** Only whitespace and the `<br>` /
  `<div>` an editor leaves behind count as blank. A field holding only an image
  is *not* empty, which is what makes an image-only front generate a card.

---

## 1. Adding a card

### Entry points

| From | Behaviour | Status |
|---|---|---|
| Deck browser → **New note** | Opens the editor with that deck preselected | ✅ |
| App header → **New note** | Opens with the *last used* deck, not the first one in the list | ◐ uses first deck |
| **`a`** anywhere, **`⌘N`** | Global shortcut into the editor | ○ |
| During review → card menu → **Add note** | Same deck as the card being reviewed; returns to the same card afterwards | ○ |
| Global card browser (Phase 6) | Add with the current filter's deck preselected | ○ |

### The Add surface

The same component as Edit — the note type decides the fields, not the layout —
with four differences that only apply when adding:

1. **Add without leaving.** The primary action is `Add` (⌘↵), which saves,
   clears non-sticky fields, keeps the note type, deck and cursor, and toasts
   *"Added 2 cards"* with an **Undo**. Adding twenty cards is one screen and
   twenty keystroke-runs, never twenty navigations. Editing an existing note
   keeps today's behaviour: `Save note` returns to the browser.
2. **Sticky fields.** A per-field toggle that carries the value to the next add.
   Anki calls it *Remember last input*. The real use is a Source or Lecture field
   held constant across a session. Stored on the note type
   (`field_config[i].sticky`), not on the note.
3. **Duplicate warning.** The first field is checksummed; another note of the
   same type with the same checksum marks the field and offers *Show duplicates*.
   Non-blocking — duplicates are legal, they are just usually a mistake.
4. **Tag autocomplete.** `Command`-backed, over tags already in the collection,
   with `space` committing a tag. Today it is a plain text input.

### Field editing

| Capability | Status | Note |
|---|---|---|
| Bold, italic, underline | ◐ bold/italic | `execCommand`. Swap for a real editor the first time someone wants tables. |
| Cloze, next ordinal | ◐ button only | |
| Cloze, **same** ordinal | ✗ | How you blank two spans as one card. |
| Maths | ✅ button, inserts `\(…\)` | |
| Image from file | ✅ | Content-addressed by sha256. |
| **Image from paste** | ○ | **The gap that matters most.** Medical students paste screenshots constantly; a file picker is the slow path. `onPaste` → `clipboardData.files` → `storeMedia`. |
| **Image drag-and-drop** | ○ | Same handler, `onDrop`. |
| Audio recording | ✅ | Writes Anki's `[sound:…]`. |
| Video | ○ | The media pipeline is mime-agnostic; only the capture UI is missing. |
| Paste-as-plain-text `⌘⇧V` | ○ | Pasting from a PDF otherwise brings a stylesheet with it. |
| Strip formatting on paste by default | ○ | Anki's default. Ours should match, with the modifier inverting it. |
| HTML view `⌘⇧X` | ○ | Needed the first time an import renders wrong. |
| Field collapse, RTL, per-field font | ○ | `field_config`. Low priority until an import needs it. |

### Tags

Space-separated on the note, as in Anki ✅. Two behaviours are not modelled:

- **Hierarchical tags.** `anatomy::thorax::valves` is one tag with a tree the
  browser can collapse. We store the string, so the data is already right — what
  is missing is the sidebar, and the rule that selecting a parent selects its
  children.
- **Reserved tags.** `marked` is Anki's per-note bookmark (distinct from a card
  flag), and `leech` is written by the scheduler (§6). Both are ordinary tags with
  UI attached, so they cost a filter and an icon, not a schema change.

### Preview and validation

Live preview per generated ordinal, labelled FRONT / BACK, is ✅. `Add` is
disabled while the note generates no cards, with the reason stated — ✅.

### Keyboard contract

`⌘↵` add · `⌘⇧C` cloze next ordinal · `⌘⌥⇧C` same ordinal · `⌘M` maths ·
`⌘⇧X` HTML view · `⌘⇧P` preview toggle · `⌘1…9` jump to field · `Esc` cancel.

**None of it is bound.** ○ The toolbar buttons above work; every shortcut in this
list is unimplemented, including the ones named beside a ✅ capability. The review
screen has its keys (`space`, `1`–`4`, `u`); the editor has none, and the editor is
where the volume is.

---

## 2. Every stock Anki note type

| Type | Cards per note | Mechanism | Status |
|---|---|---|---|
| Basic | 1 | `{{Front}}` → `{{Back}}` | ✅ |
| Basic (and reversed card) | 2 | second template swaps the fields | ✅ |
| Basic (optional reversed card) | 1 or 2 | `{{#Add Reverse}}` — card 2 exists only while that field is filled | ✅ |
| Basic (type in the answer) | 1 | `{{type:Back}}`, LCS character diff on reveal | ✅ |
| Cloze | 1 per distinct `c<N>` | `{{c1::text}}`, `{{c1::text::hint}}`, nested, no depth limit; ordinals read from **every field**, gaps preserved, `c0` ignored | ✅ |
| Image Occlusion | 1 per ordinal, so 1 per mask unless masks are grouped | rect / ellipse / polygon; Hide-All-Guess-One and Hide-One-Guess-One; **shapes sharing an ordinal are one card**, which is Anki's grouping | ◐ polygons render and import but cannot be **drawn** |

Imported and custom note types land in the same table with their own templates
and CSS and go through the same renderer. There is one rendering path; the six
above are just the ones with a fixed editor.

---

## 3. The template language

### Implemented

| Feature | Syntax | Status |
|---|---|---|
| Field substitution | `{{Field}}` | ✅ |
| Plain text | `{{text:Field}}` | ✅ |
| Conditional | `{{#Field}}…{{/Field}}`, `{{^Field}}…{{/Field}}` | ✅ |
| Back side | `{{FrontSide}}` | ✅ |
| Typed answer | `{{type:Field}}`, `{{type:cloze:Field}}` | ✅ — see the divergence below |
| Cloze | `{{cloze:Field}}` | ✅ |
| Hint | `{{hint:Field}}` | ✅ compiled to `<details>`, not a click handler — the frame runs no JS |
| Occlusion | `{{occlusion:Field}}` | ✅ SVG overlay |
| Specials | `{{Tags}} {{Type}} {{Deck}} {{Subdeck}} {{Card}}` | ✅ |
| Per-note-type CSS | `.card { … }` | ✅ injected into the sandboxed frame |
| Unknown filters | anything else | ✅ value passes through — one broken filter must not blank a collection |
| Broken templates | unbalanced `{{/X}}` | ✅ ignored — one bad template must not take 4,000 other cards down |
| Conditionals on specials | `{{#Tags}}`, `{{^Tags}}`, `{{#Deck}}` | ✅ falls out of treating specials as fields |
| Filter chaining | `{{text:hint:Back}}` | ✅ right to left — the filter nearest the field name runs first, as in Anki |

### Not yet, and what each one costs

| Feature | Syntax | Plan |
|---|---|---|
| Cloze conditionals | `{{#c1}}…{{/c1}}` | Ordinal-aware section in `emit()`. Small. Phase 3, before the importer — real shared cloze decks use it to put per-ordinal hints on the back. |
| Card flag | `{{CardFlag}}` | Renders `flag1`…`flag7` for CSS to key off. Trivial. |
| Typed, accent-insensitive | `{{type:nc:Field}}` | Normalise combining marks before the diff. Trivial. |
| Japanese readings | `{{furigana:}} {{kana:}} {{kanji:}}` | Currently pass through raw. A parser over `漢字[かんじ]`. Ship as a filter plugin, low priority — not this audience. |
| Text-to-speech | `{{tts en_US:Field}}` | Web Speech API in the **parent**, same as KaTeX, because the frame runs no JS. The card emits a marker; the app owns the speak button. |
| **Deck override** | template-level setting | The one with real teeth — see §4. |

### When a card's ordinal is not in the field being clozed

Scanning every field means card 2 can exist because of a `{{c2::…}}` in Back Extra
while the template only renders `{{cloze:Text}}`. That card's front then shows Text
with nothing blanked — a question with no question in it. Anki behaves the same
way, so we match it rather than inventing a rule, but the **editor should warn**:
a generated ordinal that no rendered field blanks is almost always a typo. That
check belongs next to the duplicate warning in §1.

### Two deliberate divergences from Anki's rendering

Both fall out of the card frame having **no JavaScript** (PLAN.md §3.5), and both
are visible to a user, so they belong here and not only in a code comment:

- **The type-in box is a React control outside the frame.** Anki puts the input
  inside the card, where a template can style and position it. `{{type:…}}`
  compiles to an empty `.type-slot` marker and the real input is rendered
  underneath the card. Imported templates that position the box with CSS will not
  get what they asked for. The comparison output on the back *is* inside the
  frame and is styled normally.
- **`{{hint:…}}` is a `<details>`, not a click handler.** Same behaviour,
  keyboard-accessible for free, but a template that styles Anki's hint anchor
  will miss.

A field whose name collides with a special — a note type with a field literally
called `Tags` or `Deck` — resolves to the special, not the field. That is Anki's
precedence and it is what we do.

### LaTeX fidelity, stated honestly

Anki shells out to a real LaTeX install and caches PNGs. We run KaTeX. Delimiters
`\(…\)`, `\[…\]`, `[$]…[/$]`, `[$$]…[/$$]`, `[latex]…[/latex]` all parse ✅, but
`[latex]` blocks in the wild contain full LaTeX — `\begin{tabular}`, `tikz`,
`\usepackage` — and KaTeX renders maths, not documents. Those will show KaTeX's
own inline error, which is the right failure: visible, per-card, and it names the
macro. **Measure it during Phase 4** against a real imported deck before deciding
whether the answer is a server-side render job or a documented limitation. A
bundled MathJax is not the answer: ~1 MB for a handful of macros.

---

## 4. Deck override — the gap with teeth

An Anki card template can carry a **Deck Override**: cards from that template go
to a named deck instead of the note's deck. The classic use is a reversed
template sending its cards to a "Recognition" deck studied on a different
schedule.

We list it in the matrix and implement none of it. Today `regenerateCards` puts
every card in the note's deck, and `cards` has no deck column at all — deck
membership is inferred through `notes.deck_id`.

**This is Phase 3, before the importer**, because an import that silently collapses
overridden cards into one deck is a data-shaped lie the user will not notice for
months.

Cost: `cards.deck_id` (nullable — null means "follow the note"),
`CardTemplate.deckOverride`, and every deck-scoped query gains
`COALESCE(c.deck_id, n.deck_id)`. That is `deckTree`, `nextCard`, `counts` and
`notesInDeck` — the four that already have to agree with each other.

---

## 4.5 Note identity — the omission that would have broken re-import

A shared deck ships v1, you study it for a month, the author ships v2. Re-importing
has to **update** the notes you already have and leave their scheduling alone.

Anki decides that by **GUID**: `notes.guid`, a short random string minted once when
a note is created and never changed, carried through every export. Not by content,
not by row id, and not by checksum — checksum is only the duplicate *warning* in the
add screen.

**We do not store one.** Without it every re-import of an updated deck inserts a
second copy of every note, and every export mints new identities, so the deck we
write cannot be updated by anyone either. This is the single thing in this document
that would have been discovered late and been expensive.

| | Rule |
|---|---|
| Import matches on | `guid`, always. Same guid ⇒ update fields and tags in place, keep cards and history. |
| Import falls back to | insert. Never to checksum — two notes can legitimately share a first field. |
| Checksum is for | the duplicate warning while adding, and nothing else. |
| Notes we create | mint a guid at insert, never rewrite it, and export it unchanged. |
| Media | referenced by sha256 here, by filename in an `.apkg`. Export names each file for its hash and writes the `media` map; two imported filenames holding identical bytes dedupe to one file, which is lossless for rendering. |
| Note types match on | name plus field signature, not id — ids collide across collections. |

---

## 5. Generation and regeneration

| Rule | Status |
|---|---|
| Front renders to something ⇒ card exists | ✅ |
| Editing re-runs generation | ✅ |
| New ordinal ⇒ new card | ✅ |
| Withdrawn ordinal ⇒ card deleted, review history kept | ✅ |
| Returning ordinal ⇒ **history replayed**, not restarted | ✅ better than Anki |
| **Editing a note type regenerates every note of that type** | ✗ **missing** |
| Cloze ordinals come from the field, not the template list | ✅ |
| Occlusion ordinals come from the mask list | ✅ |
| Ordinals stay dense when a mask is deleted | ✅ |

### Regeneration has one trigger, and it is the wrong one

`regenerateCards` runs from `saveNote` and nowhere else, so generation is
re-evaluated only for the note you just edited. Every operation in §7 changes the
*note type* — adding a template, removing one, renaming a field, changing which
type a note uses — and each of those changes what every note of that type should
generate. Without a fan-out, adding a template to a 4,000-note type creates zero
of the 4,000 cards it should, and removing one leaves 4,000 cards rendering from a
template that no longer exists.

So: **a note-type write regenerates every note of that type**, batched, in one
transaction, and it is the same `regenerateCards` — which means returning cards
find their history exactly as they do on a single edit. It needs a progress
surface at 4,000 notes, and it is the reason §7 is Phase 3 work rather than a
later nicety.

### Undo

Review undo exists — it drops an unsynced row and replays the rest of the log.
**Add and edit have no undo at all**, and §1's "toasts with Undo" is a spec, not a
description. Undoing an add is clean (delete the note and its cards; a note that
new has no review rows). Undoing an *edit* means keeping the previous field values
for the length of the toast, which is where it stops being free.

---

## 5.5 The deck half of "add a card to a deck"

Cards go in decks, and **there is no way to make a deck.** The only `INSERT INTO
decks` in the codebase is the seeder; the app ships with five decks and no user
can ever have a sixth. The note editor's deck picker lists what already exists.
That is a bigger hole in "adding a card to a deck" than anything in the type
matrix, and it was missing from this document too.

| Need | Status | Note |
|---|---|---|
| Create deck | ○ | Including as a child — the tree is `parent_id`, so "new subdeck" is the same call with a parent. |
| Rename, move, delete | ○ | Delete cascades to notes and cards; the review log is append-only and keeps its rows. Needs a real confirmation with counts. |
| Create inline from the editor's deck picker | ○ | Typing a name that does not exist should offer to make it. This is where most decks actually get created. |
| **`A::B::C` ↔ tree mapping** | ○ | Anki has no deck tree — it has flat names with `::` separators. Import must split on `::`, creating missing ancestors; export must join the path back. Round-trip has to be lossless, and `::` inside a deck name is the edge case that breaks it. |
| Deck options presets | ✗ | Anki shares one options group across many decks. We keep per-deck values — one number each, not thirty. |

---

## 6. The scheduling-side behaviours that belong to card types

| Behaviour | Status | Note |
|---|---|---|
| Suspend, flag | ✅ | Flags are 1–7 in Anki; we store an int and use 1. |
| **Audio autoplay** | ✗ | Anki plays `[sound:…]` automatically on the question and again on the answer, with a deck option to stop it. We render a control and wait to be clicked. In a script-less frame the `autoplay` attribute still works, so this is a template decision plus a deck option — but replay-on-demand needs the parent to own the element, like the `{{type:}}` box. |
| Bury one card | ✅ | |
| **Bury siblings** | ○ | Anki buries a note's *other* cards when one is answered, so you don't see Front→Back and Back→Front in the same session. `bury()` takes one id; it needs the note's other cards too, gated on a deck option. This is the most-noticed missing behaviour for reversed decks. |
| **Filtered decks / custom study** | ○ | Cram sessions: cards move to a temporary deck and return. Needs `cards.original_deck_id` + `original_due`. Its own phase — PHASES.md §7. |
| Leech detection | ○ | Phase 6. Lapse count crosses a threshold ⇒ tag `leech` and suspend. Phase 6 needs it for the weaknesses view anyway. |
| Per-deck new/day and retention | ✅ | |

---

## 7. Note type management

None of this exists, and Phase 3 cannot land without most of it.

| Capability | Why it is needed |
|---|---|
| Add / rename / reposition / delete a field | An import brings note types whose fields must survive a rename without detaching notes. |
| **Change note type** with field and template mapping | Anki's own flow. Also the repair path when an import maps badly. Field map and template map, both explicit, both previewed. |
| Sort field (`sortf`) | Which field the browser sorts and displays. We use "first non-empty", which is a guess that is wrong for any type whose first field is an id. |
| First-field checksum | The duplicate warning in the add screen. Phase 3. Note it is *not* how import matches notes — that is the guid (§4.5). |
| Template add / remove / rename | Custom types have N templates; removing one must delete its cards and keep their history, which §0 already gives us for free. |
| Per-note-type CSS editing | Behind "Advanced". PLAN.md §3 is explicit that normal users get fixed kinds and no template editor — that stays true. |

### Fields on an Anki note type we currently drop on the floor

Phase 4 must either carry these or drop them *knowingly*, because an export that
loses them silently degrades the deck for everyone who imports it back into Anki:

| Anki field | What it is | Decision |
|---|---|---|
| `latexPre` / `latexPost` | Per-note-type LaTeX preamble and postamble | **Carry.** Decks that use `\usepackage` put it here, and §3's LaTeX note is incomplete without it. |
| `latexsvg` | Render LaTeX as SVG rather than PNG | Carry as opaque; we render with KaTeX either way. |
| `bqfmt` / `bafmt` | Per-template *browser* question/answer format — how the row reads in the card list | Carry opaque now; the global card browser (Phase 6) is the first thing that could honour it. |
| `did` | Template deck override | §4. |
| `sortf` | Sort field index | §7. |
| `originalStockKind` | Which stock type a custom type was cloned from | Carry opaque. |

Anything carried opaque lives in one `anki_extra` JSON column, not six columns —
they exist to survive a round-trip, not to be queried.

---

## 8. Schema this implies

One migration, appended — never edit a shipped one.

```sql
-- 3
-- Note identity (§4.5). Minted once, never rewritten, survives every export.
ALTER TABLE notes ADD COLUMN guid TEXT;
UPDATE notes SET guid = lower(hex(randomblob(8))) WHERE guid IS NULL;
CREATE UNIQUE INDEX idx_notes_guid ON notes(guid);
  -- Backfill before the index. SQLite permits many NULLs in a unique index, so
  -- the wrong order fails silently later instead of loudly now.

ALTER TABLE notes ADD COLUMN checksum INTEGER;      -- first field, stripped
CREATE INDEX idx_notes_dupe ON notes(note_type, checksum);

ALTER TABLE note_types ADD COLUMN sort_field INTEGER NOT NULL DEFAULT 0;
ALTER TABLE note_types ADD COLUMN field_config TEXT NOT NULL DEFAULT '[]';
  -- JSON per field: { sticky, rtl, collapsed, description, font, size }
ALTER TABLE note_types ADD COLUMN anki_extra TEXT NOT NULL DEFAULT '{}';
  -- latexPre/latexPost/latexsvg/bqfmt/bafmt/originalStockKind, opaque

ALTER TABLE cards ADD COLUMN deck_id TEXT REFERENCES decks(id);
  -- NULL = follow the note. Template deck override (§4).
```

`CardTemplate` gains `deckOverride?: string | null`. Filtered decks add
`original_deck_id` / `original_due` when that feature lands, not before.

---

## 9. Build order

| Work | Phase | Why there |
|---|---|---|
| Paste and drag-drop images, paste-as-plain-text | **next** | Smallest ratio of effort to daily annoyance in the whole app. |
| Cloze conditionals, `{{CardFlag}}`, `{{type:nc:}}` | **3** | Real shared decks use them; cheaper to add before the importer than to debug after. |
| **`notes.guid`** | **3, first** | Without it no deck can ever be updated by a re-import, in either direction. Everything else in Phase 3 assumes it. |
| Deck create / rename / move / delete, `A::B::C` mapping | **3** | Import cannot land without the mapping, and nobody can make a deck today at all. |
| First-field checksum + duplicates | **3** | The add screen's warning. *Not* how import matches — that is guid. |
| Deck override | **3** | An import that collapses it is a silent lie. |
| Change note type, field management, sort field | **3** | The repair path for a bad import has to ship with the import. |
| Add-without-leaving, sticky fields, tag autocomplete, keyboard contract | **3** | The authoring loop is only tested by volume, and Phase 3 is the first time there is volume. |
| Note-type write ⇒ regenerate every note of that type | **3** | §5 — the fan-out §7 silently assumes. |
| Undo for add and edit | **3** | §1 promises it. |
| Bury siblings, leeches, `marked` and `leech` tags | **5** | The dashboard needs leeches; siblings are a deck option next to them. |
| Hierarchical tag sidebar | **5** | Lands with the global card browser, which is where tags are actually used. |
| Audio autoplay + deck option | **5** | Needs the parent to own the audio element, same shape as the type-in box. |
| Polygon **drawing** in the occlusion editor | later | Renders and imports already; drawing needs click-to-place vertices and escape-to-finish. A rectangle is what people draw over a plate. |
| TTS, furigana, hierarchical tag sidebar beyond the browser | later | Not this audience. Ship when someone asks. |
| Filtered decks | **5.5** | Its own phase in PHASES.md — it touches `nextCard`, `deckTree` and `counts`, the three queries that have to agree. |

---

## 10. Test obligations

Fixtures first, as in Phase 2 — `packages/core/src/template.test.ts` already
holds 27 and every row above that changes rendering adds one.

The two that are not unit tests:

- **Round-trip.** Import a real `.apkg`, export it, re-import: note type count,
  template count, card count and review count all stable. Phase 4's real check.
- **Deck override.** A two-template note type with an override, asserted through
  `deckTree`, `nextCard`, `counts` and `notesInDeck` — the four queries that have
  to agree. README's fourth rule, applied to the one feature most likely to break
  it.
