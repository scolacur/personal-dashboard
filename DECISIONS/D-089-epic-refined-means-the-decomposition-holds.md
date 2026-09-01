# D-089: On an Epic, `refined` means the decomposition holds — and a membership change clears it automatically

**Date:** 2026-09-01
**Ticket:** PD-610 · **Related:** [[D-080]] (the Epic is the unit of priority and dispatch), [[D-044]] (Refine), [[D-057]] (approval never dispatches), [[D-046]] (an in-flight Robot is never interrupted), PD-396

## Context

`refined` was a bare flag set in two places and cleared nowhere. Members could join an Epic four
ways — Populate, create-with-`epicId`, re-parenting, and the Add-member modal's "new ticket" option
— and none of them touched it. So an Epic could read **✓ Refined** while carrying members its
description never mentioned. Both refined Epics on the board were already in that state.

That only became a real problem under [[D-080]]. Once the Epic is the unit of dispatch, `refined`
gates things that queue work — PD-603's "Queue all members" arms every member in one click, on
exactly the precondition that the Epic and its members are shaped.

## Decision

### 1. On an Epic, `refined` asserts two things

> **The description frames the work, AND the current member set is the agreed breakdown of it.**

A claim about the Epic *and* its membership. Changing which tickets belong falsifies it.

The alternative reading — `refined` is a property of the prose alone, so membership is irrelevant —
was rejected because it makes PD-603's button a lie: it would light up on an Epic whose description
does not mention half its members.

A third option (keep `refined` as the prose flag, add a *derived* staleness signal comparing
`refined_at` to the newest member's arrival) was rejected as the primary mechanism: it is honest but
gates nothing, and the point is to stop work being queued off a stale claim.

### 2. Three states, because `refined = 0` meant two different things

| `refined` | `refine_stale` | meaning |
|---|---|---|
| 0 | 0 | never refined — the ordinary condition of 78 of 80 Epics, raises nothing |
| 1 | 0 | refined, and the member set still matches |
| 0 | 1 | **was** refined, membership has changed since |

Without the third state, warning about staleness would warn about every Epic that had simply never
been refined.

### 3. It is automatic, with no prompt

The deciding argument is that **the two ways of being wrong are not symmetric**:

- **Un-refined when it should not have been** — the badge goes dark, a human clicks ✓ Mark refined.
  One click, on an Epic they were already looking at, and the flag's movement is itself the record.
- **Left refined when it should not have been** — nothing changes, nothing is recorded, no banner,
  no re-queue warning, and *nothing ever raises it again*.

A prompt trades a cheap, visible, self-correcting error for an invisible, permanent one. A default
cannot save it, because the failure *is* someone choosing the non-default once. Declining would be a
one-way door with no reminder on the other side.

This was settled the other way twice while being decided (automatic → prompt → automatic). It is
recorded here so it is not re-opened from scratch.

**The false positives are known and accepted.** Moving a member *out* can leave an Epic more
accurate than before; an Epic whose body invites further members (PD-530 says so outright) is not
contradicted by gaining one; a reorganisation touches several Epics at once. Each costs a single
click to re-assert, which is the whole basis for choosing automatic.

### 4. One rule, two triggers — automate where precise, ask where not

PD-396 keeps a **prompt** for a body edit. That is not an inconsistency:

> **Automate where the trigger is precise. Ask where it is not.**

A membership change is exactly checkable — the set either changed or it did not, and the Epic's
claim is mechanically about that set. A body edit ranges from a typo to a rewrite, and nothing can
tell which, so asking is the only way to distinguish. Same rule, inputs that differ in kind.

### 5. A member going terminal is not a membership change

It is the Epic's plan **succeeding**, not changing. Treating it as invalidation would un-refine
every Epic the moment it started making progress.

### 6. Going stale pauses an in-progress Epic by un-arming, not by a new state

Un-armed members return to `backlog`, in-flight ones (`working` / `in-review`) are left running
([[D-046]]), and the Epic itself stays in the Queue lane.

Deliberately **no new dispatch state and no change to `robotQueueCandidates`.** That query is the
single thing deciding what the Robot picks up, and a bug in it stops every Epic rather than this
one. Un-arming reaches the same outcome with the cascade that already exists, and it never leaves a
card sitting in the Queue that will not be picked — the PD-467 trap.

### 7. Re-arming is a human act, so ✓ Mark refined is its own route

`markTicketRefined` clears the staleness **and** re-arms. A plain `PATCH { refined: true }` — the
path `approveRefine` takes — clears the staleness and re-arms nothing, because [[D-057]] reserves
dispatch to a human: an agent's proposal accepted in one click must not put members back in the
Queue. "Approve & resume" is the explicit opt-in, the Epic counterpart of "Approve & queue".

Both used to arrive through the same generic update, so the server could not tell them apart. Same
reasoning that gave Reopen its own route in PD-542.

### 8. Every movement of `refined` is a ticket event

`refine_invalidated` (with `cause`), `refine_kept` (PD-396's decline), `refine_marked` (with
`wasStale`). Nothing about `refined` was logged before, so there was no way to tell whether either
mechanism was earning its keep.

`wasStale` is load-bearing: it separates a *first* refinement from a **re-assert after an automatic
invalidation**. A re-assert landing straight after an invalidation *is* a false positive, and
without the field the two are indistinguishable. Likewise the ratio of `refine_kept` to
`refine_invalidated { cause: 'body' }` is PD-396's decline rate — a near-zero rate is the signal
that its prompt is asking a question with one real answer and should become automatic too.

This is what makes "automate it if the same option is always chosen" a measurement rather than a
guess.

## Consequences

- An Epic can be un-refined by an action taken on a *different* ticket. That is the point, and it is
  why the invalidation is logged on the Epic with the member's id in the detail.
- Re-parenting invalidates **two** Epics — the source still lists work it no longer owns.
- `refine_stale` is only ever set on an Epic. On a Ticket, `refined` has no membership half.
- PD-611 owns every surface that reports this: the banner, the band treatment, the pause
  confirmation, and the acknowledgement required to re-queue under a stale Epic.
