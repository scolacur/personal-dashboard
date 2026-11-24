# D-115: An Epic's lane is its own status; queued members do not move it (PD-968; amends D-080)

**Date:** 2026-11-24 · **Ticket:** PD-968 · **Amends:** [[D-080]] (the Epic is the unit of priority and dispatch) · **Related:** [[D-054]], [[D-089]], [[D-091]], [[D-103]]

## Decision

An unfinished Epic's board lane is **its own status, and nothing else**. A Backlog Epic is in the Backlog lane and a queued Epic is in the Queue lane, whatever its members are doing. **Completion stays derived.** An Epic reads `completed`/`closed` only when its members actually got there, unchanged from D-080.

This removes D-080's clause *"a member still in `queue` means work is live"*, under which any queued member put its Epic in the Queue lane.

## Why

Two queues are in play, and the old rule merged them:
- the **ticket queue** (`status = queue`), which feeds the Robot;
- the **Epic queue** (the Epic's own status), which feeds the ticket queue: through the auto-queue promoter (D-103), together with Steve's manual moves.

A queued ticket is not the same as its Epic being queued. The case that made this concrete is the `/harness` session claim: it sets `steve` + `queue` on a ticket Steve is working by hand. That ticket can never be dispatched (D-091, D-103), but it pulled its whole Epic into the Queue lane. On 2026-11-24 four Backlog, unrefined Epics read as queued for that reason alone. That was the second time it misled Steve into thinking work was queued and refined when it was not.

## Consequences

- `deriveEpicLane` (`apps/server/src/widgets/task-monitor/store.ts`) no longer looks at member status for the pending lanes.
- Queued members under a Backlog Epic stay visible. `EpicSummary.queued` counts them, and the Epic card shows "N in Queue".
- **The stale-Epic pause (D-089) keeps its old trigger.** It used to test "derived lane is the Queue". It now tests explicitly that the Epic is queued *or* holds queued members, so a stale Backlog Epic whose members were queued one by one is still paused.
- This fits the planned split of the Epic board from the ticket board (PD-874): the Epic lane board shows the Epic queue, and the ticket board shows the ticket queue.

## Not changed

- Epic rollback and the stale pause still move every non-in-flight queued member back to Backlog, including `steve`-claimed ones. That is pre-existing behaviour and out of scope here.
