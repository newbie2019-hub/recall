# Recall — study sessions together

A plan, written against what Phase 9 already built. Nothing here is started.

Companion docs: **[PHASES.md](PHASES.md) §9** (live co-editing, shipped) ·
**[PLAN.md](PLAN.md)** (architecture) · **[AI.md](AI.md)** (the metering and
evidence conventions this follows).

---

## 1. What already exists, and what it decides

Phase 9 shipped **full simultaneous co-editing** of a deck: a `Y.Doc` per deck,
Reverb as the transport, `deck_collaborators` with owner / admin / editor /
viewer, invitations, a roster screen, and a presence bar naming who is in the
deck. Four pieces of it decide almost everything below.

**There is already a presence channel per deck.** `routes/channels.php` admits
anyone with a role on the deck and publishes `{id, name, role}` — deliberately
not the email address. A session over a deck therefore has an authorized
membership list *today*, with no new authorization surface to get wrong.

**Client events are already switched on.** `config/reverb.php` sets
`accept_client_events_from` to `members`, so presence-channel members can
`whisper` to each other. Ephemeral session state needs no table, no controller,
no migration and no broadcast event class — it is the one kind of data the
server is genuinely better off never seeing.

**Sharing a deck deliberately does not share a history.** The `Y.Doc` holds
notes and fields and *not* scheduling; `doc.test.ts` asserts the document's key
set for exactly this reason. README rule 1 makes `reviews` append-only and
per-person, and `cards` a derived cache rebuilt from it.

**Rule 4: a count is a promise.** Nothing a second person does may change what
your deck list says is due.

Together those give the one hard constraint this whole design hangs off:

> **A session may share attention. It may never share a review log.**

Two people in a room answering the same deck produce two independent logs, two
independent schedules, and two independent sets of due counts. A session that
wrote into somebody else's log would break rule 1, rule 4, and the only reason
any of the numbers in this app can be trusted.

---

## 2. What a session is for

The evidence this product is built on — retrieval practice, spacing,
interleaving — is about **one person retrieving**. A session where someone else
answers for you deletes the retrieval and keeps the feeling of work, which is
the worst trade in learning science.

So a session is not built to make recall better. It is built for **adherence**:
the reason people study at a set time with other people is that they turn up.
That is a real effect and an honest claim, and it is the one this feature should
make in its own copy.

It follows that the shared quantity is **a total, not a ranking**.

> The metrics design (the plan behind `StatsPage`) rules out leaderboards,
> percentiles and composite scores on the strongest harm findings in the
> learning-analytics literature: peer comparison helps high achievers and
> demotivates the struggling, who are exactly the people who join a study group
> for help. Every comparison in the app today is against *your own past* or a
> goal you set.
>
> A session inherits that. **"We have answered 240 cards between us" is
> cooperative; "you are 4th of 5" is the thing the evidence says not to build.**
> Individual counts appear, small, in join order — never sorted by score, never
> ranked, never with a medal.

This is a product call and it is the product's to reverse. It should be reversed
knowingly, not as a side-effect of adding a progress bar.

---

## 3. Scope

### In

| | |
|---|---|
| **Together mode** | Everyone studies the same deck at the same time, each from **their own queue**, with their own scheduling. Shared: who is here, a live group total, and each member's own count for this session. |
| **A session strip** | One thin, static line on the review screen. Updates when somebody answers, never between. |
| **Join by deck** | A session exists for any deck you already have a role on. No new sharing model. |
| **Start / join / leave** | And an automatic end: the session is the people in it, so it stops existing when the last one leaves. |

### Out, and why

| Cut | Reason |
|---|---|
| **Lockstep / presenter mode** | §7. It is the genuinely interesting one and it needs a shared cursor over two different queues. Ship Together first and find out whether anyone wants it. |
| **Chat during a card** | A message arriving mid-retrieval is the single most effective way to destroy the thing being measured. If chat ever lands it is *between* cards and nowhere else. |
| **Any leaderboard, XP, badge or streak-versus-streak** | §2. |
| **A friends graph** | A session rides on `deck_collaborators`, which already answers "who may be in this room". A social graph is a different feature with its own privacy surface; do not grow one by accident here. |
| **Server-side session records** | §4. Nothing durable is worth the migration yet. Revisit if "sessions you were in" ever becomes a screen somebody asks for. |
| **Voice** | A different product, and the media transport is not the shape for it. |

---

## 4. Data model: none

**No migration. No table. No controller. No broadcast event.**

A session is the set of people currently subscribed to `deck.{deckId}` who have
announced themselves as studying. That is already a presence channel with an
authorization rule and a membership list.

The state each member publishes is ephemeral and self-reported:

```ts
interface SessionBeat {
  /** Whose beat this is. Checked against the presence member id on receipt. */
  id: string
  /** Cards this person has answered since they joined this session. */
  answered: number
  /** When they joined, so the strip can order by arrival and never by score. */
  since: number
  /** `studying` while a card is on screen, `idle` after two minutes of nothing. */
  state: 'studying' | 'idle'
}
```

Sent as a client event (`whisper('session', beat)`) on two triggers: **on
change**, and **every 10 seconds as a heartbeat**. The heartbeat is what makes a
late joiner converge — a whisper is not stored, so somebody arriving ten seconds
in sees nothing until the next beat, and one beat is an acceptable wait for a
number that is decorative.

A member who has not beaten in 30 seconds is dropped from the strip; the
presence channel's own `leaving` event handles a clean exit.

**This is self-reported and unverifiable.** A member could whisper any number
they like. That is acceptable *because the total is cooperative*: there is
nothing to win by inflating it, which is a property the design gets for free by
refusing to rank people. It is also worth writing on the screen — "counts come
from each person's own device" — rather than implying an audit that does not
exist. If ranking is ever added, this stops being acceptable and the whole
transport has to move server-side. That is one more reason not to add ranking.

---

## 5. The client

**New:** `apps/web/src/lib/collab/session.ts` — a `StudySession` class beside
`CollabSession`, sharing the same `acquireEcho()` instance and the same channel
name. It does not touch the `Y.Doc` and must not: the document is content, this
is attention.

```
subscribe(deckId)  → presence members, live
announce(beat)     → whisper, debounced like provider.ts already debounces
on('beat')         → merge into a Map<userId, SessionBeat>, expiring at 30s
leave()            → releaseEcho(), same refcount the collab session uses
```

**New:** `apps/web/src/hooks/useStudySession.ts`, mirroring `useCollabSession`
exactly — same shape, same lifecycle, same `idle` state for the overwhelmingly
common case of studying alone. A hook that returns `idle` costs nothing.

**New:** `apps/web/src/components/collab/SessionStrip.tsx`.

`/study` sits **outside `AppShell` on purpose** — it is the one screen in the app
with nothing to click but the four ratings, and PHASES calls a nav bar there a
feature working against itself. A session strip is a deliberate exception and
has to earn it:

- One line, above the card, never beside the rating buttons.
- **It repaints on an answer, not on a timer.** Nothing moves while a card is on
  screen. A live counter ticking during retrieval is the same mistake as chat.
- Group total large, individual counts small and in join order.
- Dismissible for the rest of the session, remembered in `localStorage` like
  every other per-device view preference.

**Changed:** `Review.tsx` calls `announce()` after `answerCard` resolves — after,
so a number that went up is a review that landed. `StudyPage` reads
`?session=1` and passes it down; the deck screen and the deck menu grow a
**"Study together"** entry that navigates there.

Nothing else in the study loop changes. In particular the queue does not: each
person's cards come from their own `cards` table exactly as today.

---

## 6. What will go wrong

Written before building, in the order they will actually bite.

1. **Two tabs, one person.** Presence lists a member per connection, so a second
   tab doubles you and doubles the total. Dedupe by user id on receipt, keeping
   the highest `answered` — and note that this makes the total a lower bound
   rather than a sum of beats, which is the correct reading anyway.
2. **The strip fights the review screen.** The most likely outcome of this whole
   feature is that studying becomes slightly worse for everyone. Build it
   dismissible on day one and look at whether people dismiss it.
3. **Whispers are unauthenticated beyond channel membership.** Covered in §4 and
   only covered while nothing ranks.
4. **A member with no cards due.** They join, study nothing, and read as idle
   forever. Say "caught up" rather than "idle", which reads as a rebuke.
5. **Reverb is not running in development for everyone.** `useCollabSession`
   already degrades to `idle`; the session hook must do the same, and the deck
   menu should hide the entry rather than offer a room nobody can enter.
6. **`releaseEcho()` refcounting.** Two live subscriptions over one Echo
   instance, and the collab session may already hold one. Checked while writing
   this: `echo.ts` counts refs and only disconnects at zero, so a session
   leaving will not tear down a co-editing connection in the same tab. What is
   *not* handled is leaving the **channel** — both subscriptions name
   `deck.{id}`, so whichever unsubscribes second must be the one that leaves it.
7. **A deck you can see but not study.** Viewers have a role and therefore
   presence. They can study their own copy, so this is fine — but check it,
   because "can read the document" and "has cards" are different questions.

---

## 7. Lockstep, if it is ever asked for

The interesting mode and the reason this doc stops short of it.

**One person advances; everyone sees the same card; everyone grades privately
into their own log.** It is the classroom and study-group shape, and it is what
people usually picture when they say "study together".

The hard part is not the transport, it is that **your queue and mine contain
different cards**. The presenter's card may not be due for me, may be suspended
for me, or may not exist on my device yet. So lockstep needs:

- The presenter's card *identity* on the wire (a note id and ordinal), not an
  index into a queue.
- A rule for a card the follower does not have due. Answering it is a real
  retrieval and should count — the app already has a name for "study something
  early on purpose", and it is a **filtered deck** (Phase 7). Lockstep should
  build one rather than invent a second path into the scheduler.
- A rule for a card the follower does not have *at all* — show it read-only and
  grade nothing, because grading a card you do not own has nowhere to go.

That is a week of work sitting on top of a feature nobody has used yet. Together
mode is three days and answers whether the room is worth entering.

---

## 8. Order of work

1. `session.ts` + `useStudySession.ts` — presence, beats, expiry. Testable
   without any UI, the way `provider.test.ts` tests a session against a fake
   server.
2. `SessionStrip.tsx`, dismissible, static between cards.
3. `Review.tsx` announce-after-answer; `StudyPage` wiring; the deck menu entry.
4. e2e: two browser contexts against one deck, both answer, both totals agree.

**Done when:** two people study the same deck at the same time, each sees the
other's count and a shared total, **and each one's due counts, intervals and
review log are byte-for-byte what they would have been studying alone.** That
last clause is the whole feature's correctness condition and the e2e should
assert it by exporting both collections and diffing the revlogs.

---

## 9. Sources

- PHASES.md §9 — what live collaboration already ships, and what it refuses to.
- README rules 1 and 4 — the append-only log and "a count is a promise".
- The metrics design behind `StatsPage` — self-referenced comparison only; the
  leaderboard finding, and why this doc inherits it.
