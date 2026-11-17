# D-096: Refine is an asynchronous question queue, auto-started on every new ticket and paced by how fast Steve answers

**Date:** 2026-11-16 · **Epic:** PD-742 ([Epic] Async Refine — structured questions, Decisions inbox, auto-start) · **Extends:** [[D-044]] (the Refine session), [[D-091]] (robot work enters the Queue only refined) · **Leaves standing:** [[D-084]] (approval writes content, never placement), [[D-057]] (approval never dispatches)

## Context

D-091 made refinement the hard gate between the backlog and the Robot. On 2026-11-16 the board
held 505 backlog tickets, and 3 were refined. Refinement has become the backlog's bottleneck,
and each session needs Steve's product decisions.

Refine was already asynchronous in its transport: the agent-worker polls DB turns, and Steve can
reply whenever. Three other things made it slow:

- **A session starts only when Steve clicks Refine.** Nothing grills a ticket before he opens it.
- **Questions arrive as free-text chat.** Each reply means re-reading a long agent turn and typing
  answers to numbered questions. The questions Steve answered fastest that day were multiple-choice
  with a marked recommendation.
- **Open sessions are scattered across ticket pages.** Steve has to visit each one. Five of the nine
  sessions flagged "awaiting you" were not actually waiting on him (see §6).

## Decision

### 1. Every new unrefined ticket auto-starts a Refine session, whoever created it

That includes Steve, Ticket Audit, Robot follow-ups and widget- or page-card suggestions.
Agent-created tickets carry the least context, so they gain the most. Decompose children are born
refined (D-091 §7) and skip it.

### 2. Cost is paced by Steve's answering, not by the size of the backlog

No new auto-session starts while the number of open rounds (tickets awaiting Steve) is at a cap,
default 15. Auto-Refine also honors the Robot loop's budget and the shared session-limit hold.
A daily cap was rejected: it spends tokens on rounds nobody is ready to read, and it starves
when Steve has time to answer. The cap ties both to the one scarce input, his attention.

### 3. The existing backlog drips in, priority first, behind new tickets

A backfill feeds the same scheduler from unrefined tickets, ordered P0→P4 and then by age, only
while nothing newly created is waiting. A member of an unrefined Epic is refined through its
Epic, since siblings share their decisions. An Epic can be excluded from backfill (wishlist
Epics), and its members inherit that.

### 4. Questions are structured, and the format is enforced, not just suggested

A question round is an `ask_questions` tool call, not prose. Each question carries 2–4 options
with exactly one recommended, a line on why it matters, and a free-text Other. The tool rejects a
malformed round, the way `propose_commit` rejects a malformed proposal, so the agent corrects
itself. A ticket id with no title is rejected too, because a bare id is unanswerable without a
lookup (the `/harness` id rule). "Accept all recommendations" answers a round in one click.

### 5. The agent settles what the record already settles, and says so

Anything DECISIONS/ or PROJECT.md already answers becomes a stated assumption citing the decision,
which Steve can overrule. Only genuine product calls become questions. This keeps rounds short
without hiding the agent's reasoning.

### 6. A session that ended stops waiting on Steve, and Park ends one without a commit

A ticket's Refine state was derived from its newest `refine_human` or `refine_agent` event only.
A session that ended in an approved commit therefore read as `awaiting-human` forever, and an
open-round cap counting those would never drain. The derivation now also considers the
session-ending events: `refine_committed`, and a new `refine_parked` that Steve writes from a
**Park** button. A turn newer than either reopens the session. `refine_rejected` does **not** end
a session, because rejecting a proposal invites another. The list of ending types lives in
`@dashboard/shared` (`REFINE_SESSION_END_TYPES`), and the server's SQL is built from it, so the
two cannot disagree.

### 7. Answers happen in one Decisions inbox, and on each ticket's page

A Decisions page lists every open round across tickets, by priority and then age, each answerable
inline. The same form appears in the ticket's thread. The card's awaiting pill and the Notification
Center point there.

## Consequences

- Approval is unchanged: a human approves, approval writes content only (D-084) and never
  dispatches (D-057). Async Refine produces proposals faster. It never queues anything.
- The open-round count becomes a load-bearing number. Anything that leaves a session falsely
  "awaiting" (the §6 bug) now stalls the scheduler, not just a pill.
- Free-text chat stays available. The structured round is how the agent asks; Steve can still type.
