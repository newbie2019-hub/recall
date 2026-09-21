# Recall — AI features & usage accounting

Companion to [PLAN.md](PLAN.md) (architecture) · [PHASES.md](PHASES.md) (order of
work) · [CRITIQUE.md](CRITIQUE.md) (what the build got wrong). This file replaces
the two paragraphs PHASES §10 gives AI, because the research says the interesting
problem is not generation — it is **not shipping bad cards**, and **knowing what
each call cost**.

Revision log at the bottom: this document was written once and revised twice, and
§6 is almost entirely what the two revisions found.

---

## 1. What the evidence says, and what it forbids

Three findings decide the whole design.

**The scheduling science is settled and we already ship it.** Retrieval practice
has a reliable medium effect (g ≈ 0.50 for testing, d ≈ 0.40 for transfer,
g ≈ 0.50 in applied classrooms); spacing retrieval episodes adds to it;
interleaving adds again. FSRS, the append-only review log and filtered decks are
the whole of that. **No AI feature may touch scheduling.** An LLM cannot beat a
fitted FSRS model at predicting recall, and anything that reorders the queue
breaks the "a count is a promise" rule the app is built on (README rule 4).

**Card generation is where models actually fail.** The Memory Machines benchmark
(Kirkby & Matuschak, 1,500 labelled cards across 93 sources) scores prompts T0–T3
and the best model tested reached **64.3 % usable**. The dangerous tier is not T0
(off-target — models detect those at 93 %) but **T1: structurally broken cards
that look fine and degrade over months of review** — ambiguous, multi-answer,
shallow, wordy, or too narrow. Models can read a highlight's *intent* and cannot
judge whether a prompt *survives*. Grounding — showing the judge labelled
examples from the same source — moved precision 56 % → 78 %.

Read that against README rule 1: `reviews` is append-only and FSRS derives state
from it. **A bad card does not just waste a session — it compounds through the
scheduler and through the log, permanently.** That is why every generated card is
a suggestion, and why the approval screen is the feature rather than a step in
front of it.

**The one thing AI is unambiguously good at here is explaining a lapse.**
Elaborative interrogation and self-explanation are established effects, and they
need exactly what a model is good at: prose, on demand, about one specific error.
This is also the cheapest feature in the list — one short call, no pipeline.

### What this forbids

| Forbidden | Why |
|---|---|
| AI adjusting intervals, due dates, or retention targets | FSRS is fitted; a model is not. Breaks rule 4. |
| Auto-inserting generated cards | 36 % of frontier-model cards are unusable, and the unusable ones look fine. |
| Any AI call between rating a card and seeing the next | Offline-first. The study loop must work on a plane, forever. |
| Model-authored HTML anywhere | README rule 5. Card HTML renders in a script-less iframe *because* it is untrusted; generated HTML is untrusted twice. |
| An untracked call to Anthropic | §3. There is exactly one code path to the API and it writes the ledger row. |

---

## 2. The features, ranked by learning value per line

### 2.1 Source → candidate cards, with a grading pass · the committed one

PHASES §10 already scopes upload → extract → chunk → candidates → **mandatory
approval**. Three changes the research forces:

- **A second, separate grading call.** Generation writes candidates; a *grader*
  scores each against the five-dimension rubric (lacks context / multiple
  answers / shallow / wordy / narrow) and returns T0–T3 plus a one-line reason.
  T0 and T1 are dropped before a human ever sees them — the benchmark's own
  recommendation is to minimise T1 rather than maximise apparent output.
- **Grounded grading where it is free.** The grader gets the source chunk the
  card came from, which is the cheap half of the 56 → 78 % precision result. The
  expensive half (labelled exemplars per source) is not built; noted, not done.
- **Every card cites its chunk**, stored on the candidate, shown on the approval
  row, and discarded once the card is accepted. A citation is for the reviewer,
  not for the deck.

**The approval screen is default-reject.** Candidates arrive unselected. You
accept, page of ten at a time, with the source excerpt beside the card. There is
no "select all". CRITIQUE §5 already named the failure — "approval UX must make
rejection fast or users rubber-stamp garbage" — and a wall of sixty pre-ticked
cards *is* the rubber stamp.

Accepted candidates are written through **the same note-creation path
`NoteEditor` uses**. They are ordinary notes with ordinary GUIDs, so the
generation rule re-runs, cloze ordinals are scanned, siblings are buried, Anki
export carries them and sync ships them. There is no "AI note" and no table for
one.

### 2.2 Card doctor — the same grader, pointed at cards you already have

The grader is a component, not a step in a pipeline, so run it over an existing
deck: **the imported Anki deck, the cloned marketplace deck, the cards you wrote
at 2am.** It returns "these eleven cards are ambiguous, and here is why", with an
edit link.

This is the best feature in the document and it costs almost nothing beyond
§2.1, because it is §2.1's second half with a different input. It is also the
only one no competitor has: everyone generates cards, nobody audits them. And it
is what makes a 20,000-card Anki import *better* rather than just imported —
which is the answer to CRITIQUE's "the failure mode is shipping Anki-with-extra-
steps".

Batched: one call grades twenty cards, not twenty calls.

### 2.3 "Why was I wrong?" — explanation at the point of failure

A button on the answer side, after `Again`, and on a leech. One call, the card
plus the note's other fields as context, out comes a short explanation and one
"and here is the thing people confuse it with". `packages/core/src/leech.ts`
already detects leeches with reasons; this is the sentence that reason was
missing.

Online-only and explicitly so: the button is disabled offline with the reason,
and rating the card never waits for it.

### 2.4 Weakness briefing — one component, not a registry

`db/queries/stats.ts` already computes weakness. The AI writes two paragraphs
over numbers it is *given*, never over numbers it computes, and it is rendered by
**one** vetted React component.

PHASES §10 asks for a registry of five — summary, comparison table, timeline,
concept map, weak-topic callout — bound to structured JSON. CRITIQUE scored that
8.5 and called it "a solution looking for a problem", and it was right. **Build
the one component.** The registry is the generalisation of a thing that has not
yet been shown to be worth building once. `ponytail: one component; add the
registry when a second one is asked for by name.`

### 2.5 Cut, and why

| Cut | Reason |
|---|---|
| AI chat tutor | Unbounded cost per user, unbounded scope, no ceiling on the session. §2.3 is the 5 % of it that carries the evidence. |
| AI-authored deck descriptions for the marketplace | The moderation queue does not need more text to read. |
| Auto-tagging notes | Search is `LIKE` over three columns and unindexed (CRITIQUE). Fix the index before adding generated tags to it. |
| Voice / lecture transcription | A different product. Whisper-shaped, not Claude-shaped, and the media transport is not built yet. |
| Generative-UI registry | §2.4. One component first. |

---

## 3. Usage accounting — the part that must be right on day one

**The rule: there is exactly one place in this codebase that calls Anthropic, and
it cannot return without writing a ledger row.** Everything else follows.

### 3.1 One gateway, no wrapper library

`app/Services/Ai/Claude.php`. It owns the SDK client, takes a `feature` enum and
a `User`, and writes `ai_usage` in a `finally`. No feature calls the SDK. No
feature computes cost. A new feature that wants the API adds an enum case, which
is a compiler-visible act.

This is the "thin wrapper around the provider client that records the usage
object" pattern, and it is the whole of the metering architecture. There is no
vendor, no OpenTelemetry span exporter, no separate meter service.
`ponytail: MySQL is the meter. Move to an event stream when one database cannot
hold the write rate, which is not a problem at any user count this app will see
before it has revenue.`

### 3.2 The ledger is append-only, like everything else that matters here

`reviews` is append-only. `listing_moderation_events` is append-only.
`doc_updates` is append-only. `ai_usage` is append-only, for the same reason all
three are: **the derived number must be rebuildable from the log.** A
`credits_remaining` column that drifts from the calls that spent it is a support
ticket you cannot answer.

Quota is therefore a query, not a counter:

```sql
SELECT COALESCE(SUM(cost_micros), 0)
  FROM ai_usage
 WHERE user_id = ? AND created_at >= ?   -- period_start, stored, UTC
```

### 3.3 Store the facts, derive the dollars

Store **both**: the token counts (facts that never change) *and* the cost at time
of call (billing truth), *and* the `price_version` that connected them. Prices
move. A ledger holding only dollars cannot be re-audited; a ledger holding only
tokens cannot answer "what did we charge in March".

Cost, in micro-dollars, integer, never float:

```
cost_micros = input_tokens        × price.input
            + cache_write_tokens  × price.input × 1.25
            + cache_read_tokens   × price.input × 0.10
            + output_tokens       × price.output
```

`usage.input_tokens` **excludes** cached tokens. Adding cache tokens to it
double-counts; ignoring them under-counts a cached workload by most of its bill.
Both are easy, silent, and wrong. One unit test with hand-computed numbers, §6.

Current rates, per million tokens (`config/ai.php`, versioned):

| Model | Input | Output | Used for |
|---|---|---|---|
| `claude-opus-5` | $5.00 | $25.00 | generation (§2.1), explanation (§2.3), briefing (§2.4) |
| `claude-haiku-4-5` | $1.00 | $5.00 | the grader (§2.1, §2.2) — an LLM judge is the sanctioned place for a cheaper model |

Measured shape of a 40-page PDF, ~20k tokens of text, ~8 chunks, ~60 candidates:

| | Tokens | Cost |
|---|---|---|
| Generation, Opus 5 | 20k in / 16k out | ~$0.50 |
| Grading, Haiku 4.5, batched 20/call | 6k in / 3k out | ~$0.02 |
| **Total** | | **~$0.52** |

The grader is 4 % of the bill and removes the 36 %. That is the best trade in the
document.

**The model is `claude-opus-5` and that is a product decision, not a default.**
Sonnet 5 ($2/$10) runs the same pipeline at ~$0.20 and is the obvious lever if
the free tier hurts — but it is a quality trade on the exact axis the benchmark
says models are already weak, so it is measured against a held-out set of cards
before it ships, not swapped in to save money. See §7.

### 3.4 Quota: reserve, then settle

A quota checked once, at upload, is a quota that does not exist — **one upload is
eight generation calls plus three grading calls**, and the check has long since
passed by the eighth.

1. **At dispatch**, inside the same transaction that creates the job, estimate
   the job's cost from the extracted token count and write a `reservation` row.
   If `spent + reserved + estimate > limit`, refuse with `ai_quota_exceeded`
   before anything is queued. The transaction is what makes two tabs safe; a
   `SELECT … FOR UPDATE` on the user's period row is what makes it a lock rather
   than a hope.
2. **Before each call inside the job**, the gateway re-checks the job's remaining
   reservation. A job that overruns its estimate stops mid-way and reports
   partial results — it does not silently spend the next user's headroom.
3. **On completion**, the reservation is released and the real rows stand. The
   ledger is the truth; the reservation only ever existed to stop concurrency.

Estimates are allowed to be wrong. The reservation is a ceiling, not a forecast.

### 3.5 Period boundaries

`users.ai_period_start` is a stored UTC timestamp, advanced by a scheduled
command, never computed from `now()` per request. A period derived from wall
clock on each call grants a second allowance across a DST boundary and denies one
across the other. The same bug shape as the compaction watermark in Phase 9 —
arrives late, looks like something else.

### 3.6 What the ledger is not

- **Not syncable.** It is not in `SyncResource`, for the same reason
  `import_jobs` is not: it is a fact about the machine that ran the work, not
  about the collection. Pushing spend data to every device is a privacy question
  nobody asked for.
- **Not kept forever.** Rows roll up monthly into `ai_usage_monthly` and are
  pruned after 13 months. The Yjs log taught this: an append-only table without a
  written compaction story is a performance incident scheduled for month six.
- **Not deleted with the account.** Account deletion nulls `user_id` and keeps
  the aggregate — the same shape as `listing_installs` having no FK to decks.
  Billing records outlive the account; personal data does not.

---

## 4. Schema

```sql
-- APPEND ONLY. One row per Anthropic API call, successful or not.
ai_usage(
  id              uuid pk,
  user_id         uuid null fk→users cascade,  -- nulled, not deleted, on account deletion
  feature         varchar(32),        -- generate|grade|explain|brief
  job_id          uuid null,          -- ai_jobs.id, for per-job attribution
  model           varchar(48),
  input_tokens    int unsigned,
  cache_write_tokens int unsigned,
  cache_read_tokens  int unsigned,
  output_tokens   int unsigned,
  cost_micros     bigint unsigned,    -- integer micro-dollars, never float
  price_version   varchar(16),        -- which config/ai.php table produced cost_micros
  status          varchar(16),        -- ok|refusal|truncated|error
  stop_reason     varchar(24) null,
  request_id      varchar(64) null,   -- Anthropic's, for support
  latency_ms      int unsigned,
  created_at      timestamp,
  index (user_id, created_at),        -- the quota query
  index (job_id)
)

ai_usage_monthly(user_id, month, calls, input_tokens, output_tokens, cost_micros)

-- Mirrors import_jobs deliberately: upload once, poll until done.
ai_jobs(
  id uuid pk, user_id uuid fk, kind varchar(16),      -- source|doctor
  source_name varchar, source_path varchar null,
  status varchar(16),                                  -- queued|running|done|failed|partial
  stage varchar(16),                                   -- extracting|generating|grading
  done int, total int,
  estimated_micros bigint unsigned, reserved_micros bigint unsigned,
  error text null, created_at, updated_at
)

ai_candidates(
  id uuid pk, ai_job_id uuid fk cascade,
  note_type_id uuid, fields_json json, tags json,
  tier tinyint,                        -- 2|3 only; T0/T1 never reach here
  grade_reason varchar(255),
  source_ref json,                     -- {page, char_start, char_end} or {region}
  content_hash char(64),               -- dedupes across re-runs and within a job
  status varchar(12),                  -- pending|accepted|rejected
  unique (ai_job_id, content_hash)
)

users.ai_period_start  timestamp   -- UTC, advanced by schedule, never from now()
users.ai_plan          varchar(16) -- free|pro; the limit lives in config, not the row
users.ai_consent_at    timestamp null  -- §6.10
```

`config/ai.php` holds the price table, the price version, and the per-plan
monthly `limit_micros`. Limits in config, not in rows — a price change is a
deploy, not a migration over every user.

---

## 5. Endpoints

All under the existing `auth:sanctum` group in `routes/api.php`, following the
throttle reasoning already written there.

```
POST   /ai/jobs                 throttle:10,60   upload or deck-id; returns ai_jobs row
GET    /ai/jobs/{job}            —               poll; scoped to the account, like imports
GET    /ai/jobs/{job}/candidates —               paginated, T2/T3 only
POST   /ai/jobs/{job}/accept     throttle:60,1   {ids: []} → notes, via the normal path
DELETE /ai/jobs/{job}            —               abandons; deletes the upload
POST   /ai/explain               throttle:30,60  one card → one explanation, no job
GET    /ai/usage                 —               this period: spent, limit, by feature
```

`GET /ai/usage` exists so the number is in the product, not just in the database.
Settings shows spend and what is left; **`POST /ai/jobs` returns the estimate
before it runs**, because "this will use about a fifth of your month" is the only
honest way to let someone decide.

Polling is unthrottled, for the reason `imports.show` is: polling is the client's
normal state and a rate limit on it looks like a failure.

---

## 6. What will go wrong — the two revision passes

This is the section the revisions produced. Each item is a real failure mode with
the guard that closes it.

**6.1 Retries bill twice.** `ImportApkgJob` sets `tries = 1` and says why. Copy
it: an AI job that killed a worker will kill three, and each attempt is a real
charge. Anthropic's own 429 is the exception — that retries with backoff *inside*
the gateway, which is also the only place it can be counted correctly.

**6.2 A refusal is a 200 and a truncation is a full bill.** `stop_reason:
"refusal"` returns HTTP 200 with no usable content, and `max_tokens` truncation
returns a partial answer at full price. Both must write a ledger row —
`status: refusal` / `truncated`. Recording only successes under-reports the bill
by exactly the calls you most need to see.

**6.3 A thrown exception after the call landed is a silent free charge.** The
ledger write is in `finally`, not after the return. If the response parsed and
the mapping blew up, the money is already spent.

**6.4 Streaming reports usage at the end.** Usage arrives on the final
`message_delta`, not the first chunk. Take it from the accumulated final message.
A dropped stream must still write a row with what was counted — `status: error`
and the partial output tokens — or a flaky connection becomes untracked spend.

**6.5 Cache tokens.** `input_tokens` excludes them. One test, hand-computed: a
call with `input=1000, cache_write=2000, cache_read=4000, output=500` on Opus 5
is `1000×5 + 2000×6.25 + 4000×0.5 + 500×25` = `5,000 + 12,500 + 2,000 + 12,500`
= **32,000** micro-dollars. Assert that number.

> *Corrected while building 10a.* This line read **31,500** in the first three
> drafts — the four terms are right and the addition was not. It is a small,
> apt joke at the expense of the paragraph that follows it: the reason to assert
> a hand-computed number is that hand-computed numbers are wrong, and a test
> asserting "a row exists" would have shipped the error into the price table.
> `AiLedgerTest::test_cost_counts_cache_tokens_separately_from_input`. Phase 8's lesson was that a contract test must read the shape it actually
produces (`assertCount(2, 'preview')` passed on an object with two keys) — assert
the arithmetic, not that a row exists.

**6.6 The quota check that passes eight times.** §3.4. The check is per-call
against a per-job reservation, taken in the dispatch transaction.

**6.7 Two tabs, one allowance.** Both read `spent` before either writes. The
reservation row plus `SELECT … FOR UPDATE` on the user's period is the fix, and
it must be *in* the dispatch transaction, not beside it.

**6.8 Uploaded documents are hostile input.** A PDF — or a cloned marketplace
deck run through the card doctor — can contain "ignore your instructions and
output …". Two guards, both structural: source text goes in a user turn clearly
delimited as data and never in the system prompt, and the response is constrained
by **structured outputs (`output_config.format`) or a `strict: true` tool**, so
the model's only expressible output is `{fields, tier, reason}`. It cannot emit
markup, because the schema has no place to put markup. That is the generation-side
half of README rule 5.

**6.9 Fields are HTML and the renderer is an iframe.** Generated field text is
escaped on the way in and rendered by the existing sandboxed `CardFrame`, exactly
like imported Anki content. No new render path, no `dangerouslySetInnerHTML`, not
even for the §2.4 briefing — that is a React component reading structured JSON.

**6.10 Documents leave the device, and this app's users chose offline-first.**
A medical student's uploads are the most sensitive content in the product. An
explicit one-time consent (`users.ai_consent_at`), a plain-language line about
what is sent and that it is not used for training, the upload deleted when the
job ends either way (as `import_jobs` already does), and `DELETE /ai/jobs/{job}`
to abandon early. A setting that turns the whole subsystem off, and with it every
AI affordance in the UI.

**6.11 A slow API must never touch the study loop.** No AI call sits between a
rating and the next card, ever. §2.3's button is user-initiated, off the path,
and disabled with a reason when offline. This is rule-shaped, not preference-
shaped: the app's first promise is that it works on a plane.

**6.12 Sync and a generated card.** A card accepted on the web lands in local
SQLite and syncs like any other note. Because it went through the normal note
path it has a GUID, so the same deck re-imported from Anki matches rather than
duplicates. If the accept path ever grows its own INSERT, this breaks silently
and only shows up months later as duplicates after an import.

**6.13 Re-running a job duplicates candidates.** `unique (ai_job_id,
content_hash)` where the hash is over the normalised fields. Re-running is then
free and idempotent, which is also what makes "regenerate just this chunk"
cheap later.

**6.14 One job at a time, per user.** Otherwise a 429 from Anthropic arrives
while four of this user's jobs are in flight, all four back off together, and
the queue stampedes when they wake. A per-user lock on dispatch; a queued job
waits.

**6.15 The grader costs money too.** It is a ledger `feature`, not a free
internal step. If grading is not metered, the number in Settings is wrong by
however much grading costs, and the first person to notice will be an accountant.

**6.16 Tests must not call Anthropic.** `Claude.php` resolves from the container
and the suite binds a fake returning a canned `usage` object. Every test in §6
above is then a unit test with exact numbers — which is the point, because the
failures in this section are all arithmetic and ordering, not network.

**6.17 `ai_usage` in `SyncResource` would be a privacy bug, not a feature.**
§3.6. Worth naming because the enum is where a well-meaning future change goes.

**6.18 The ledger grows without bound.** §3.6. Rollup and prune are written now,
with a command, not discovered later.

---

## 7. Order of work

Each step is usable on its own, per the rule every phase in PHASES.md follows.

| | Work | Est. | Ends with |
|---|---|---|---|
| **10a** | Gateway + ledger + quota + `GET /ai/usage` + Settings panel. **One feature only: §2.3 explain.** | 4 days | A button that explains a lapse, and a number in Settings that is provably right. |
| **10b** | The grader, over existing cards — §2.2 card doctor. | 3 days | "Eleven cards in this imported deck are ambiguous, and why." |
| **10c** | §2.1 pipeline: upload → extract → chunk → generate → grade → candidates → default-reject approval screen. | 6 days | A 40-page PDF yields cards you would keep. |
| **10d** | §2.4 briefing, one component. | 2 days | Two paragraphs over the weakness numbers on the dashboard. |
| | | **~3 weeks** | |

**10a before 10c is the whole point.** PHASES §10 builds the pipeline first and
adds accounting after, which is the order that produces an untracked bill. Ship
the meter with the cheapest feature, prove the arithmetic against real calls, and
every feature after it is metered by construction.

**10b before 10c** because the grader is the risky component and the doctor is
the cheapest way to find out whether its judgements are any good — on cards whose
quality you already have an opinion about, before it is deciding what a stranger
sees.

**Before 10c ships**, run the §2.1 pipeline over five real sources and hand-score
the output T0–T3. If the kept rate is not materially better than the benchmark's
64 %, the grader is not working and the approval screen is carrying the whole
feature. That is the measurement that decides the Opus-vs-Sonnet question in §3.3
as well — same held-out set, both models, compare kept rates against the
2.5× price difference.

**Done when:** a 40-page PDF yields cards you would actually keep; the number in
Settings matches the Anthropic console to the cent; and turning AI off in
Settings leaves an app that still works on a plane.

---

## 8. Deliberately not built

| | Why it waits |
|---|---|
| Registry of generative-UI components | §2.4. One component until a second is asked for by name. |
| Grounded grading with labelled exemplars | The 56→78 % result needs per-source labels. Impractical now; the chunk-level half is built. |
| Batch API for generation | 50 % cheaper and asynchronous, which suits the doctor sweeping a 20k-card deck. Not the upload path, where someone is watching a progress bar. Revisit once the doctor has volume. |
| Prompt caching | The chunk changes every call, so there is no stable prefix worth a breakpoint yet. When the rubric and few-shot exemplars grow past ~2k tokens, cache that prefix and re-check `cache_read_input_tokens` is non-zero. |
| Stripe, plans, upgrade flow | The ledger is what billing would need. Billing is a different project and this one does not have paying users yet. |
| Per-feature rate limiting beyond the route throttles | The quota is the real limit. Two limiters disagreeing is a support ticket. |

---

## Revision log

Written once, revised twice, as asked. What each pass changed:

**Pass 1 → 2, the design.** The first draft had AI generation as the headline and
accounting as a subsection. The benchmark numbers inverted it: if 36 % of
frontier-model cards are unusable and the bad ones are the plausible-looking
ones, then the *grader* is the product and generation is the commodity — which is
what produced §2.2, the card doctor, a feature that did not exist in the first
draft and is now the most distinctive thing in the document. The draft also
carried PHASES §10's registry of five generative-UI components; CRITIQUE had
already scored that 8.5 and called it a solution looking for a problem, so it
became one component. Ordering flipped too: accounting now ships in 10a with the
cheapest feature, because the first draft's order — pipeline first, meter after —
is exactly how a bill gets away from you.

**Pass 2 → 3, the bugs.** §6 grew from four items to eighteen. The ones that
would have bitten: quota checked once per upload when an upload is eleven calls
(6.6); cache tokens double-counted because `input_tokens` excludes them (6.5);
refusals and truncations billing without a ledger row because they are HTTP 200
(6.2); the ledger write sitting after the return instead of in `finally` (6.3);
two tabs passing the same check (6.7); retries billing twice (6.1); period
boundaries computed from `now()` (§3.5); and the ledger growing unbounded with no
compaction story, which is precisely the Phase 9 Yjs mistake (6.18). The last
pass also added the thing the codebase's own post-mortems keep pointing at: the
test must assert the arithmetic with hand-computed numbers, because Phase 8
shipped three contract bugs whose tests passed (6.5).

**Pass 3 → 4, written after building it.** Three changes the code forced.

**§3.4's reservation was half-built.** `ai_jobs.reserved_micros` was written at
dispatch and read by nothing: `canSpend` summed `ai_usage` alone, so a queued
document holding almost the whole allowance was invisible to an interactive
call, and two uploads could both pass the same check. `Ledger::reserved()` now
counts it. Two departures from what §3.4 describes, both because the doc's
version leaks: the reservation is **derived from the job's status** rather than
released on completion — a reservation handed back by a hook is one that leaks
the first time a worker dies, and the leak looks exactly like ordinary spending
— and it is **reduced by what the job has already charged**, or a running job
would be counted twice for the length of the work it reserved. A job is exempt
from its own reservation (`$exceptJob`), without which a document whose
estimate used the last of an allowance would reserve itself into a deadlock.

**§6.7's "two tabs" was only solved for uploads.** Every other call checked and
charged in two separate steps, so two simultaneous requests were both told the
same dollar was theirs. `Claude::call` now takes a per-account lock for the
length of a call and refuses rather than queues, which is the rule
`AiJobController` already applied to documents.

**The meter showed dollars and stored tokens.** `ai_usage` had the four token
columns from the start and `GET /ai/usage` never returned them. It does now, in
total and per feature — a price change reprices the whole history, and "how much
did I send" is the question that still has the same answer afterwards.

**§2.2 gained its other half.** The grader named a flaw and stopped, which is
right for a sweep over twenty thousand cards and wrong at the moment one is
being written. `AiFeature::Rewrite` proposes a fix, per field, applied only by
the person — the rule generated cards already follow, applied to an edit. It is
a separate feature rather than a mode of `Grade` because it has its own model,
its own risk and its own line in the meter.

---

## Sources

- [Memory Machines: evaluating LLM-generated flashcards](https://memory-machines.com/report) — Kirkby & Matuschak; T0–T3 taxonomy, 64.3 % best-model usable rate, grounding result
- [A Meta-Analytic Review of the Benefit of Spacing out Retrieval Practice Episodes on Retention](https://eric.ed.gov/?id=EJ1310148)
- [The Use of Retrieval Practice in the Health Professions: A State-of-the-Art Review](https://pmc.ncbi.nlm.nih.gov/articles/PMC12292765/) — effect sizes
- [Systematic review of distributed practice and retrieval practice in health professions education](https://pmc.ncbi.nlm.nih.gov/articles/PMC11078833/)
- [The Effectiveness of Spaced Learning, Interleaving, and Retrieval Practice in Radiology Education](https://www.jacr.org/article/S1546-1440(23)00646-4/fulltext)
- [When AI Flashcards Pollute Your Anki Deck](https://evakeiffenheim.substack.com/p/when-ai-flashcards-pollute-your-anki) — the verification-loop pattern §2.1 uses
- [Elaborative interrogation — UW-La Crosse CATL](https://www.uwlax.edu/catl/guides/teaching-improvement-guide/how-can-i-improve/elaborative-interrogation/) — the evidence behind §2.3
- [Metering LLM Token Usage: an architecture guide](https://dodopayments.com/blogs/metering-llm-token-usage-architecture) — the thin-gateway pattern §3.1 uses
- [How to track LLM costs: per-user, per-feature, per-agent-run attribution](https://www.braintrust.dev/articles/how-to-track-llm-costs-2026) — billable-vs-used tokens
- [Anki vs Quizlet vs RemNote vs Knowt](https://laxuai.com/blog/anki-vs-quizlet-vs-remnote-vs-knowt) — competitor credit models (RemNote 100/mo free, 1,000 Pro at $18/mo)
