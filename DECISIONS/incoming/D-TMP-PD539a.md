# D-TMP-PD539a: Terminal is final — a completed or closed Ticket is read-only, and leaving it is one deliberate act (PD-539; amends D-036, D-040)

## Decision

A Ticket in `completed` or `closed` is **immutable from every board surface**. It cannot be edited,
and it cannot be dragged out of its lane. The single exception is an explicit **Reopen** action on
the ticket detail page, which returns it to `backlog`.

Reopen is not a plain status write. It must:

- **attach the Ticket to an Epic**, picking one if it has none — an Epic-less active Ticket is
  unpriced and undispatchable by construction (D-TMP-PD383a), so reopening into that state would
  create exactly the invisible dead end this decision exists to prevent;
- **clear `agent_state`**, server-side, on any transition out of a terminal lane.

The Robot loop is untouched. It writes terminal transitions when a PR merges, and that is the
transition being protected, not restricted.

**Epics are deliberately not covered.** An Epic's terminal lane is *derived* from its members
(`deriveEpicLane`), so there is nothing to freeze: reopening a member un-completes its Epic on the
next read. Epics inherit this decision for free, and any attempt to freeze them directly would be a
status write the derived lane immediately overrules — the bug PD-536 fixed.

## Why

**`completed` was a lane, not a fact.** 249 of 567 tickets are terminal — 44% of the board — and 190
of those were freely editable and freely draggable back into Backlog. A count you can change by
dragging is not a record of what happened, and "how much did we finish" is the main question the
board is asked.

**Every other part of the system already treats terminal as an ending.** PD-400 tears the agent
session down on entry: clears `agent_state`, resolves open notifications, logs `session_ended`.
`isStatusLocked` (D-058) already freezes robot-completed tickets — 59 of them. The board was the last
surface that let a finished thing quietly become unfinished.

**Resurrection has a known failure mode.** PD-467: a parked ticket re-queued from the board produced
a card that looked perfectly normal in the Queue and could never dispatch, with nothing saying so.
Reopening is the same shape of move, and the same class of bug — which is why Reopen carries the
Epic and `agent_state` obligations rather than being a bare status change.

## Why an explicit Reopen, rather than no way back at all

A hard freeze with no escape is a cleaner rule, and it was rejected for one reason: **entering
terminal is a single drag.** Making that gesture irreversible turns an easy slip into permanent
damage, recoverable only by duplicating the ticket — which loses its issue link, run history and
relations, i.e. exactly the record the freeze exists to protect.

The alternative considered was to keep terminal fully irreversible and add a confirmation when
*entering* it. That trades a rare deliberate act (reopening) for friction on a common one
(completing), and confirmations on common actions get clicked through without reading. A deliberate
click on a detail page cannot be reached by accident, which is the property actually wanted; a
confirm dialog on a drag only looks like it has that property.

## Deliberately not done here

- **No server-side refusal of terminal edits.** The loop writes to terminal tickets by design
  (`completeTicket`), and the reconciliation sweeps read and write them. A server guard would have to
  distinguish the loop from a human, which the API has no notion of. The enforcement is the board's,
  and it is honest about being the board's.
- **No backfill.** Nothing about existing terminal tickets changes; they simply stop being editable.
