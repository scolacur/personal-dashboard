# D-TMP-PD510a: Approving a Refine proposal writes content, never placement (PD-510; strengthens D-057, implements D-TMP-PD383a)

## Decision

Approving a Refine proposal writes **body, assignee and `maxTurns`, and nothing else**.

- **It never moves a Ticket between lanes.** The proposal's `status` is recorded in the event log
  as part of what was proposed, but no write reads it.
- **There is no Ticket priority, anywhere in Refine.** `propose_commit` no longer accepts one, on
  the parent or on a child; `RefineProposal` no longer carries the field; the approval panel no
  longer displays it.
- **Every decompose/Populate child is created in `backlog`**, whatever lane the proposal named.

The single exception is **"Approve & queue"** (`opts.queue`), which still dispatches. That is Steve
clicking a button — identical in kind to a board drag, and the act D-057 reserves to him. What
D-057 forbids is approval dispatching *on its own*, which this is not.

## Why

**The old behaviour spent agent turns on values that were thrown away.** Priority is an Epic
property that the write path cascades to members (D-TMP-PD383a). A Ticket-level priority therefore
had nowhere to land: on a member it was overwritten from the Epic a moment later; on an Epic-less
Ticket it stuck and disagreed with the model. The agent was still asked for it, still reasoned about
it, and the approval panel still displayed it — so the discard was invisible from both ends. Not
offering a field is more honest than offering one and ignoring it.

**The lane rule was a coercion chain that grew a case per retired lane.** Approval parked an
agent-proposed `queue` in `prioritized`; PD-417 added `robot_queue`/`steve_queue` normalization;
D-TMP-PD383a retired `prioritized` and re-pointed the park at `backlog`. Each step kept the shape —
a lane write derived from what the agent asked for — and each needed the next fix. Not reading
`status` at all ends the sequence rather than extending it.

**It also closed two quieter holes.** A proposal naming `backlog` on a Ticket already in the Queue
would have pulled it back out on approval, un-dispatching live work as a side effect of a body
rewrite. And a child proposed as `completed`/`closed` was created *already terminal* — work asserted
as finished before it existed, which under D-TMP-PD539a is now also unreachable and hard to undo.

**Creating into `backlog` makes D-039 structural here.** "An autonomous agent may create into
backlog only" stops depending on a coercion that has to enumerate the lanes it rejects; there is no
lane input to get wrong. `createTicket` independently forces a member of a queued Epic to `backlog`
(D-TMP-PD383a), so the two guards agree without either relying on the other.

## Deliberately not done here

- **Refine proposing Epic priorities**, and **agents asking permission to queue** — both deferred by
  D-TMP-PD383a. Refine argues urgency in `rationale`; Steve prices the Epic.
- **Removing "Approve & queue."** A literal reading of "approval never changes a lane" would take
  it, but it closes no hole: the board still lets a single Ticket be dragged into the Queue, so
  removing the button would cost a click and change nothing about what is reachable.
- **Rejecting a Ticket priority loudly.** A proposal persisted before this decision may still carry
  the key in its stored JSON. It is simply not read. Removing the field from the *type* is what
  makes every reader a compile error rather than a value that quietly does nothing.
