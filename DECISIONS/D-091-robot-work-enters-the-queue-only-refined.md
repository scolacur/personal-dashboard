# D-091: Robot work enters the Queue only refined — one predicate, enforced at every door the server owns, with the loop as backstop

**Date:** 2026-11-13 (decided 2026-09-02)
**Ticket:** PD-632 · **Amends:** [[D-058]] ("`ready` is the dispatch gate") · **Extends:** [[D-089]] · **Related:** [[D-051]] as amended by PD-408 (blockers gate at dispatch), [[D-080]] (the Epic cascade), [[D-057]] (approval never dispatches), PD-633 (the refusal modal), PD-634 (Refine output born refined)

## Context

Before this, the only dispatch preconditions were `ready` (the four-section body shape, [[D-058]])
and the [[D-051]] blocker skip. `refined` was set in two places, rendered on cards, and read by
nothing that decided anything — the glossary said so outright: *"Ready is about the body's shape,
not about a session having run."*

Two facts shaped the implementation:

- **The only Ready gate was client-side.** `needsQueueBypass` lives in the board; the server never
  checked `ready`. A raw `PATCH` put an unformatted robot ticket in the Queue, and `approveRefine`'s
  "Approve & queue" routed around the modal entirely. A UI-only gate is advisory.
- **Robot work had more ways into the Queue than a PATCH.** Queueing an Epic cascades every `backlog`
  member in ([[D-080]]); ✓ Mark refined on a stale queued Epic re-arms its members ([[D-089]] §7);
  "Approve & resume" does the same; "Approve & queue" moves a ticket in from inside the store.

## Decision

### 1. A robot-assigned ticket enters the Queue only if it and its Epic are refined — hard, no bypass

`ready` keeps its bypass, because "I know it isn't formatted, run it anyway" is a real thing to want.
There is no honest equivalent for refinement: dispatching work nobody has read is never the intent,
and satisfying the gate costs one click of ✓ Mark refined. So refinement is hard where `ready` is
bypassable.

Human work is never gated. `assignee = 'steve'` dispatches nothing, and the `/harness` claim
(`{assignee: 'steve', status: 'queue'}`) depends on it passing.

### 2. One predicate: `queueBlockers()`, returning criteria, not a boolean

`packages/shared/src/task-monitor.ts`, beside `isReady`. It returns an ordered list — `refined`,
`epic-refined`, `epic-not-stale`, `members-refined`, `ready`, `unblocked` — each with `met`,
`bypassable`, `refusesEntry`, and a `remedy` naming where it is satisfied. The server returns the
whole list on refusal, so the board (PD-633) renders the server's answer rather than re-deriving it.

**`members-refined` is derived and never stored.** "This Epic is refined but its members aren't" is
computed from the members on demand. [[D-089]]'s three Epic states (never refined / refined / stale)
stand unchanged; a fourth stored state would be one more flag for every write path to keep in step.

### 3. `unblocked` is reported, not refused at entry

PD-632 as filed marked `unblocked` hard at the guard. That would have reversed PD-408's amendment to
[[D-051]], which deliberately moved the blocker gate from *entry refusal* to *dispatch-time skip*: a
blocked ticket may wait in the Queue and the loop passes it over until its blocker resolves, so a
prerequisite chain can be queued at once. Nothing in PD-632 argued for undoing that, so it stands.
The criterion is still returned (`refusesEntry: false`) so the modal can show it truthfully.

`ready` is likewise `refusesEntry: false`: the server has never refused on it, and the bypass is a
client acknowledgement this decision does not move.

### 4. Enforced where it is real — every server door into `queue ∧ robot`

| Door | Behaviour |
|---|---|
| `PATCH` a ticket into the state (status → `queue`, assignee → `robot`, or a queued robot ticket re-parented) | refused, `409 QUEUE_GATE` + criteria |
| `PATCH` an Epic → `queue` that would arm a robot member | refused on the Epic-level criteria; nothing is armed |
| "Approve & queue" | refused the same way, judged on the ticket *after* approval (so approving satisfies its own `refined`) |
| ✓ Mark refined / "Approve & resume" re-arming a stale Epic | the mark succeeds; robot members are held in `backlog` if the Epic-level criteria fail, and `epic_resume_held` is logged |

The guard lives in `ticket-guards.ts` with the other PD-542 HTTP-boundary rules, injected with a
read context so it stays DB-free; the store reuses it for Approve & queue.

**Resume holds rather than refuses** because the act is ✓ Mark refined: refusing the mark because a
member is unrefined would make the one control that satisfies the gate refuse to run. Holding robot
members in `backlog` also never leaves a queued card the loop will not pick — the PD-467 trap
[[D-089]] §6 was written to avoid.

**A write that keeps a ticket in the state without changing what gates it is not re-judged**, and
un-refining a queued ticket is allowed (PD-396 makes that reachable). That case belongs to the loop.

### 5. The loop adds `refined = 1` as a backstop, and names what it skips

`robotQueueCandidates` adds `t.refined = 1`. This amends [[D-089]] §6's "no change to
`robotQueueCandidates`" deliberately and narrowly: it checks only the ticket's own flag, the one
thing the guard cannot see change after entry. The Epic-level criteria are not repeated there — they
are enforced on entry, and a going-stale Epic already un-arms its members.

A skip is never silent: `queuedButUnrefined` is warned every cycle, next to PD-467's
`queuedBlockedByAgentState`, because a skipped card looks exactly like an idle loop.

### 6. Rejected: auto-marking an Epic refined once its last member is refined

It would make `members-refined` self-healing, and it defeats [[D-089]]'s invalidation: add a member →
the Epic un-refines; refine that member → the Epic silently re-refines, and the human never sees the
invalidation the mechanism exists to raise. Steve's first instinct was the auto-mark; this argument
reversed it on 2026-09-02. (A Populate marking its Epic refined is a different thing — that is the
Refine session itself, where the claim originates. PD-634.)

### 7. A Refine session's output is born refined — the agent declares, the server verifies (PD-634)

*Added 2026-11-13 by PD-634; decided 2026-09-02 with the rest of this record.*

A gate on `refined` is only livable if the flag is set where the reading actually happens. So:

- **Children are born refined.** The proposal's per-child `refined` defaults to true, because the
  session *is* the read-through. Re-refining what a session just produced is the churn this gate is
  meant to avoid. The agent sets `refined: false` only for a placeholder that needs its own session.
- **The server checks the claim.** A robot-assigned child whose body fails `isReady` lands unrefined
  whatever the proposal said, so no card reads refined while being undispatchable. A human-assigned
  child skips that test: `refined` and `ready` are different properties ([[D-058]]).
- **A Populate rewrites the Epic's body, then marks it refined.** The body is required for a decompose
  on an Epic (refused by `propose_commit`, re-checked at approval). With it, approving asserts both
  halves of [[D-089]]'s claim on evidence Steve read in one panel. It is marked **last**, after every
  member has joined, because each join fires `invalidateEpicRefinement`. It uses a plain update, not
  ✓ Mark refined, so approval never re-arms a paused Epic ([[D-057]]).

This is not the auto-mark rejected in §6: that one re-refined an Epic when a stray member got
refined, undoing an invalidation nobody saw. This one is the Refine session, where the claim originates.

## Consequences

- **The migration window was used.** At ship time the Queue held no robot-assigned ticket, so adding
  the gate stranded nothing. The window closes the moment robot work is queued.
- **Until PD-634 lands, almost nothing is queueable for the Robot.** 2 of ~400 backlog tickets are
  refined, and Populate creates its children unrefined. That is the gate working as intended — but
  PD-634 is what makes it livable.
- **PD-633 renders the refusal.** Until then the board shows the error message, not a checklist.
- **This is a guard, not a security boundary** — the same caveat as PD-542: the loop's own SQL and an
  unauthenticated LAN client are outside it.
