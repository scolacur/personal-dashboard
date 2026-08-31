# Manual test backlog

Scenarios that shipped with automated coverage of their *logic* but have never been exercised
end-to-end through the UI. They are listed here because the reason they are untested is structural,
not lazy:

- **`apps/web` has no component-rendering tests.** Every predicate below is unit-tested as a plain
  function, but nothing asserts that the component calls it, or that the result reaches the screen.
- **Some states cannot be manufactured on demand.** A live Robot run, a merged PR, a decompose
  proposal — these need the loop running against a real repo, so they surface only during ordinary
  use.

A line moves to "verified" with the date and who checked it. Delete nothing — a scenario that was
verified once is still the record of what the behaviour is supposed to be.

---

## Terminal is final (D-083, PD-542, PD-590)

### T1 — Reopen a ticket that has no Epic
- **Setup:** a `completed` or `closed` non-Epic ticket whose `epicId` is null. Legacy rows qualify;
  the create guard no longer allows new ones.
- **Steps:** open its detail page → **Reopen**.
- **Expect:** the Epic picker opens instead of reopening. Picking an Epic reopens into `backlog`
  under that Epic. Dismissing the picker leaves the ticket terminal and unchanged.
- **Why it matters:** reopening without an Epic recreates the unpriced, undispatchable dead end
  D-080 exists to prevent. The server refuses it (`reopenGuardFailure` → `EPIC_REQUIRED`); this
  checks the UI never lets you reach the refusal.

### T2 — Reopen clears a stale `agent_state`
- **Setup:** a ticket completed by the loop, so it carries `agent_state = 'done'`.
- **Steps:** Reopen it. Read the header badges, and `agentState` over the API.
- **Expect:** lane is `backlog`, and **no green "done" pill**. `agentState` is null.
- **Why it matters:** `robotQueueCandidates` selects on `agent_state IS NULL OR 'queued'`. A
  reopened ticket still wearing `done` looks back in play but can never be picked up again.

### T3 — Clearing the Epic field on an edit is refused
- **Steps:** edit an active non-Epic ticket that has an Epic, clear the Epic field, Save.
- **Expect:** refused with the `EPIC_REQUIRED` message ("A Ticket cannot be removed from its Epic —
  move it to another one instead"). The error appears **inline**; the page is not replaced.
- **Why it matters:** the inline-vs-replaced distinction is the PD-590 fix. A guard refusal is an
  action failure, not a load failure, and must never blank the ticket you were reading.

### T4 — A terminal ticket is read-only, except for its position
- **Steps:** on an Epic's member list, drag a **completed** member to a new position.
- **Expect:** the reorder **succeeds**. Editing that member's title/body/priority/assignee is still
  refused.
- **Why it matters:** `sortOrder` was in the refused set at first, which broke reordering the whole
  list whenever one completed member sat in it. Position is not a claim about what happened.

### T5 — A live run cannot be dragged out of the Queue
- **Setup:** needs a real run — a ticket in `queue` with `agent_state` of `working` or `in-review`.
- **Steps:** drag that card from Queue to Backlog.
- **Expect:** refused with `RUN_IN_FLIGHT`, worded for the state ("A Robot is working on this right
  now…" / "…has a Robot PR awaiting review…"). Card returns to the Queue. Error is inline.
- **Why it matters:** this is the PD-464 failure exactly. The run cannot be interrupted (D-046), so
  moving the ticket orphans it — the PR watcher is scoped to `status = 'queue'`, and nothing
  completes the ticket when the PR merges.

---

## Refine (D-044, PD-510, PD-598)

### R1 — Approving a decompose creates children correctly
- **Steps:** refine an Epic so the agent proposes a decompose. Approve it.
- **Expect:** every child is created in **`backlog`**, **unpriced** on its own (it inherits the
  Epic's priority via the cascade), assigned per the proposal, and parented to the Epic. The
  decomposed parent goes terminal. **Nothing is queued** (D-057 — approval never dispatches).
- **Why it matters:** approval is the largest single write the UI makes. D-039 (agents create into
  backlog only) is asserted here or nowhere.

### R2 — "Approve & queue" appears only where it should
- **Expect it on:** a **non-Epic** ticket with a **`refine_in_place`** proposal.
- **Expect it absent on:** any Epic (an Epic's lane is derived, so it cannot enter the Queue), and
  any decompose (children are created, so there is no single ticket to dispatch).
- **Why it matters:** verified by reading the code, never by clicking. The two absences are easy to
  misread as a bug.

---

## Dispatch order (PD-554)

### D1 — Numbered dispatch badges
- **Setup:** an Epic with **two or more** members queued at once — the badges are the answer to
  "which of these runs first", so one queued member proves nothing.
- **Steps:** queue the Epic, open its member list.
- **Expect:** members carry dispatch position numbers matching the loop's own ordering —
  `priority ASC, epic.sort_order ASC, ticket.sort_order ASC`. Members that cannot dispatch
  (not formatted, blocked, not the Robot's) are not numbered as if they were next.
- **Why it matters:** `dispatchPositions` is unit-tested; that the list renders the same numbers in
  the same order is not.

---

## The loop, under load (one session covers both)

Both of these need the same setup and can be proved in one sitting: **queue the members of PD-530
(Pomodoro Timer Widget V2 features), let the Robots run, and start a manual maintenance hold
part-way through.**

### L1 — PD-560: the numbering cycle is gone, and Robots still get real decision ids
- **Why it needs a live run:** PD-560 deleted `DECISIONS/incoming/`, the consolidation job, and the
  provisional-id half of `shared/decisions.ts`. Every test of the replacement mocks the allocator.
  Nothing has yet watched a real Robot, inside the container, reach the counter.
- **Expect:** a Robot that records a decision calls `mcp__decisions__allocate` (**not** the HTTP
  endpoint — the container's egress firewall cannot reach the dashboard, D-087), gets a real
  `D-NNN`, writes `DECISIONS/D-NNN-<slug>.md`, and regenerates `DECISIONS.md` in the same PR.
- **Watch for:** two Robots running concurrently must not receive the same id. The counter is the
  only allocator precisely because hand-picking has collided twice before (D-056, D-065).

### L2 — PD-561: a manual hold actually drains in-flight runs
- **Why it needs a live run:** every hold started in the 2026-08-23/25 testing happened to have no
  Robot working, so the window opened immediately and the drain was never exercised. The unit tests
  inject `inFlightRuns`, so none of them touch the real query — and that query has been wrong in
  production once already.
- **Steps:** start a manual hold **while a Robot is working**.
- **Expect, in order:**
  1. the hold sits `queued`, and the nav reads *Maintenance hold queued* with **no** countdown;
  2. **no further Robot is dispatched** from the moment it is queued — this is the part that makes
     the drain terminate instead of being a treadmill;
  3. the working Robot is allowed to **finish**; it is never killed (D-046);
  4. the window opens as the last run ends, and the countdown starts *then*, not before.

## Notes

- The board is an unauthenticated LAN service; all of the above can also be driven with `curl`
  against `http://192.168.68.50:8088/api/widgets/task-monitor`. Doing so tests the **guard**; doing
  it in the browser tests the **UI path to the guard**. They are different tests and both are listed
  above on purpose.
- The Robot loop does not go through the API — it opens `dashboard.db` directly — so none of the
  route guards apply to it. See `apps/server/src/widgets/task-monitor/ticket-guards.ts`.
