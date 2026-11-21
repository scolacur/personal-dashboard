# D-103: Auto-promotion into the Queue is a deterministic rule executing Steve's Epic choice — Epic-scoped, computed not stored, capacity-throttled

**Date:** 2026-11-20 · **Epic:** PD-806 (Auto-queue robot work) · **Ticket:** PD-807 · **Amends:** [[D-039]] (agent-created tickets are backlog-only), [[D-080]] (a ticket created into a queued Epic lands in backlog) · **Related:** [[D-091]] (the Queue gate), [[D-089]] (Epic refined/stale), [[D-072]] (pause vs hold), [[D-055]] (fault tiers), [[D-047]] (sensitive paths)

## Context

Since `AUTO_MERGE_ALL=on` (2026-11-20), everything after the Queue is automatic: Robot PR → Evaluator review-gate → auto-merge → deploy. The last manual step is Steve moving refined robot work from Backlog into the Queue. Most of that step is mechanical. The Queue gate ([[D-091]]) already decides whether a ticket *may* enter, and `refined` is already Steve's own attestation that the work has been read.

Two rules stood in the way:

- [[D-039]] says an autonomous agent may not queue tickets, because a human must advance them. Its worry is an unsupervised agent judging work and dispatching it, which risks runaway self-dispatch and token blowout.
- [[D-080]] makes activating an Epic (Backlog → Queue) a human move. It also says a ticket created into an already-queued Epic lands in `backlog`, because "joining an in-flight Epic's work is an explicit act".

A board snapshot on the day showed that the real bottleneck is refinement, not queueing. None of the 11 refined Backlog tickets passed the full gate: one Epic was unrefined, and another had only 6 of its 12 members refined. Auto-queueing pays off together with the auto-started Refine of [[D-096]]. With both in place, Steve's only acts are answering Refine and choosing which Epics are active.

## Decision (shape agreed with Steve on 2026-11-20)

### 1. A rule, not an agent

The promoter is a **Claude-free predicate** plus a capacity check. It makes no judgment. It only promotes tickets whose `refined` flag a human set, so it carries out a decision Steve already made. This amends [[D-039]] narrowly. The ban on *agents* queueing stands, and so does the depth cap that would relax it (PD-244). A deterministic job promoting human-refined work is not the population D-039 was drawn against.

It never sets or changes `assignee`, `ready_bypassed` or `refined`. Routing, the Ready bypass and refinement all stay human acts.

### 2. Epic-scoped

Steve still activates an Epic ([[D-080]] stands on that point). The promoter only moves members of **active** (queued) Epics, as they become eligible. That amends D-080's "a ticket created into a queued Epic lands in backlog": the ticket still lands in `backlog`, but joins the active set automatically once it passes every criterion. A global pull across all refined work by priority was rejected, because it would remove the one decision Steve clearly still wants: what's active.

The gate's `members-refined` criterion is kept as-is, even though under automation it controls how fast a partly refined Epic drains.

**The Epic's `refined` flag stays the plan claim of [[D-089]]; only its display changes.** Deriving the flag from the members ("an Epic is refined only when all its members are") was considered and rejected. Refine auto-start refines an Epic before its members and holds them back until it is settled, so a derived flag would leave members waiting on an Epic that waits on them. It would also blur "the plan changed" (stale) with "a ticket needs detail". Instead, the board shows a computed composite: **Fully refined**, or **Plan refined · N/M members**, alongside stale and not refined.

### 3. Eligibility is computed, never stored

There is **no "Queue-eligible" lane**. Eligibility goes false whenever a body edit un-refines a ticket ([[D-097]]), a blocker is added, an Epic goes stale ([[D-089]]), or a sibling becomes unrefined. A stored lane would need every one of those write paths to move the ticket back out, and missing one leaves an eligible-looking card that isn't eligible. This is the same reasoning as D-091's "`members-refined` is derived and never stored" and D-080's removal of `prioritized`. Eligibility is one pure function in `packages/shared`, built on `queueBlockers()`. The promoter, the detail-page checklist and the board's Eligible view all render its answer.

The per-ticket criteria are the hard Queue-gate criteria plus: Epic is active, `assignee = robot`, Ready (or a bypass Steve already set), unblocked, no Refine session waiting on Steve, Epic not excluded, and a robot-enabled project. Unlike D-091, `unblocked` is required here. A blocked ticket may wait in the Queue, but promoting it only adds clutter.

### 4. Pull-based, throttled by board and worker state

Promotion stops at whichever limit is hit first: dispatchable robot tickets reach `ROBOT_CONCURRENCY × 2`; robot tickets in review (including held or conflicting PRs) reach 3; one member per Epic is already queued, working or in review; or the worker is unhealthy (paused, on hold, out of budget, or with a stale heartbeat). Not-yet-promoted work stays in Backlog, where reordering it is cheap.

The promoter runs in the **server** and queues through the same store path and guard as the PATCH route. That keeps D-091's "every door the server owns" true without a second copy of the gate. It ships behind `AUTO_QUEUE=off|dry-run|on`, defaulting to `off`, and records every promotion as an `auto_queued` event with the snapshot that justified it.

### 5. The worker owns the circuit breaker

The right response to repeated run failures is to **stop dispatching**, not just stop promoting. The worker already owns the fault tiers ([[D-055]]) and the loop-wide pause ([[D-072]]). It pauses dispatch after N consecutive deterministic-tier failures across tickets, and the promoter stops as a side effect because it reads that pause. The promoter never computes failure rates itself. Resuming is a human act.

### 6. Self-modifying work is excluded, in two layers

- **At selection:** an `auto_queue_excluded` flag on the Epic, set by hand on Robot / Osiris / infra Epics. It is explicit and visible, and doesn't depend on parsing titles. Steve can still queue members of an excluded Epic by hand.
- **At PR time:** `apps/agent-worker/**` is added to `.github/sensitive-paths.txt` in the same change as this decision. A Robot PR that touches the worker then needs `sensitive-change-approved`, even if its ticket's Epic was never flagged.

## Consequences

- With the promoter on, Steve's routine acts are answering Refine, activating Epics and setting their priority. Queueing individual tickets by hand still works and is never refused for being manual.
- Every ticket and Epic detail page shows a queue-eligibility checklist, a flat list of criteria and capacity rows with ✓/✗. The board's Eligible view links to the same criteria in a modal, so what is automated is visible rather than inferred.
- The promoter adds no new way into the Queue. A refusal from the existing guard is logged, not bypassed.
- Worker PRs, including any by Steve that D-067 doesn't exempt, now show up in the path-guard summary. Robot ones need the label.
