# D-TMP-PD383a: The Epic is the unit of priority and dispatch; the `prioritized` lane is removed (PD-383; amends D-054, D-057, D-058)

**Decision:** Priority and queueing move from the Ticket to the **Epic**. The board keeps three
visible lanes — **Backlog / Queue / Completed** (plus the hidden `closed`); `prioritized` is
deleted. From the 2026-08-12 grill on PD-383:

- **Priority is an Epic property.** `P0`–`P5` is set on the Epic and **cascades to every member on
  write**. A Ticket's priority is no longer independently settable. Every Ticket must belong to an
  Epic; an Epic whose work spans genuinely different priorities is **split into two Epics** rather
  than holding mixed members.
- **An Epic's rank within its priority band is its drag order.** `sort_order` on the Epic, already
  implemented by `computeOrderWithin`, becomes the tie-break that decides which of the equal-priority
  Epics is next.
- **Order of operations inside an Epic is `sort_order`, dragged on the Epic page — never `blocks`.**
  `blocks` keeps its existing, narrow meaning: a true dependency, which the loop honours by skipping
  the blocked Ticket at selection.
- **The Epic is the unit of dispatch.** Backlog → Queue is a human move on the **Epic**; its members
  follow programmatically. This **reverses** "an Epic can never enter `queue`" (D-054, hardened by
  D-058): an Epic in Queue means *active*, which is the `in_progress` cell `EpicDerivedLane` already
  computes — now hand-set rather than derived.
- **A Ticket created into a queued Epic lands in `backlog`**, not the active set. Joining an
  in-flight Epic's work is an explicit act.
- **Rolling an Epic back (Queue → Backlog) is one rule, not a case analysis.** Un-queue the
  *unstarted* members; leave completed members completed; if anything is actively running, a single
  modal asks kill-or-finish. No spin-off Epics.
- **Queue → Completed is programmatic for `assignee = robot`** (the loop, on PR merge) **and a human
  action for everything else** — a `steve`-assigned queued Ticket is the personal to-do lane and has
  to be tickable by hand.
- **Dispatch order becomes** `epic.priority`, `epic.sort_order`, `t.sort_order`, `t.id`.

**Reasoning:**

- **Priority inflation here is a type error, not a discipline failure.** 62 of 211 active members
  outrank their own Epic: Karpathy Memory (PD-350) is a P2 Epic whose six members are *all* P1;
  PD-418 is a P3 Epic holding 3×P1 and 7×P2. Those tickets are not mislabelled — `P1` there honestly
  means "first among *this* work". A local rank written into a global field inflates that field
  mechanically, and 42 Epics × "the important ones in here" is exactly the 29 P1s the board carries.
  Putting priority on the Epic makes the field mean one thing again.
- **The `prioritized` lane was never carrying priority — it was carrying commitment.** The board
  cannot drag a card across a priority band (`computeSortOrder` narrows to the card's own band), so
  moving a ticket to `prioritized` was the *only* way to say "this beats those" — and it was used
  that way: PD-377, a P2, sat in `prioritized` above fifteen P1s in Backlog. Naming a lane after
  importance while using it for commitment is what made PD-383 hard to answer: the lane genuinely
  was redundant with priority, *and* genuinely wasn't.
- **Ordinal ranking was always the right answer to inflation; only scale ruled it out.** Position-as-
  priority enforces scarcity geometrically — one thing is first — but nobody hand-ranks 275 Tickets,
  so the coarse bucket had to stay. Moving the ranking unit to ~65 Epics puts it back in reach. This,
  not "it stops inflation", is the real argument for Epic-owned priority.
- **`blocks` cannot express order of operations without serializing the loop.** A blocked Ticket is
  skipped at selection (`robotQueueCandidates`, D-051 as amended by PD-408), so a chain drawn through
  a 15-member Epic leaves exactly one member dispatchable at a time. It also destroys the ability to
  distinguish "these are genuinely independent" from "nobody has audited this Epic yet" — both render
  as no edges. `sort_order` makes independence the free default; `blocks` keeps teeth precisely
  because it stays rare.
- **The cascade is load-bearing, not a convenience.** The entire benefit is re-prioritising one Epic
  instead of twelve members; a value copied at create time and never re-pushed would go stale on the
  first re-prioritisation, i.e. the first time the model is used as intended. Cascade-on-write
  follows the `ready` recompute precedent (D-058) — persisted, cheap for the loop to read, unable to
  drift.
- **Status is only half reversible, so only half was reversed.** Priority is pure intent and
  propagates cleanly. Status is part intent, part *observation*: the loop writes `queue` sub-states
  and `completed` per Ticket as work actually finishes, and no top-down push can be allowed to
  overwrite an observation. So the pending transition (Backlog ↔ Queue) becomes top-down while
  progress stays bottom-up.
- **The five-case rollback design was paying for an assumption that is false.** Each case existed to
  keep an Epic's members in one lane, which is why every path needed to spin off a new Epic. But a
  half-done Epic — some completed, one running, six untouched — *is* what an in-flight Epic looks
  like; mixed membership is the normal state, and it is why status was derived in the first place.
  Dropping the uniformity requirement collapses five cases into one rule and stops rollback from
  minting Epics, which would re-inflate the very list now being hand-ranked.
- **Auto-queueing new members would defeat D-039 without any agent touching a queue field.** Today
  the guarantee is that a human authorises every dispatch, because queue entry is a drag. Inheriting
  queue state from the Epic weakens that to "a human authorises every *Epic*" — and then anything
  able to add a member can create a dispatch, recursively. No agent can write tickets today (there is
  no create path in `agent-worker` and the squid allowlist reaches no LAN host), but PD-287 gives the
  Audit field-writes and PD-433 gives Refine board access. Landing in `backlog` keeps D-039
  structural rather than conventional. Agents asking permission to queue is deliberately left as
  future work.

**Implications:** `TicketStatus` and `EpicDerivedLane` both lose `prioritized`; `deriveEpicLane`'s
final `some backlog ? backlog : prioritized` collapses to `backlog`. The `EpicGuardError`
`EPIC_NOT_QUEUEABLE` throws in `createTicket`/`updateTicket` are removed and replaced by the
member-cascade. `robotQueueCandidates` gains the Epic join and the four-key `ORDER BY`. **Amends
D-057**: approval no longer has a parking lane, so "approval never dispatches" becomes the stronger
"approval never moves a Ticket at all"; Refine's `propose_commit` drops the Ticket `priority` field,
which is now invalid. Existing `prioritized` rows migrate to `backlog` — the commitment they encoded
is re-expressed by queueing the relevant Epics deliberately, rather than inferred by a migration.
The create modal requires an Epic (filter-as-you-type picker plus a "New Epic" option that takes a
name and priority). PD-339's "Dispatch ready members" stops being a power feature and becomes the
main way Epic-level intent turns into Ticket-level work.

**Deliberately not done here:** PROJECT.md §9 is **not** updated to describe this model until the
slices ship. A glossary that documents unbuilt behaviour as current is the exact failure that
produced the PR #268 path-guard incident, where an agent trusted PROJECT.md's description of a
control that did not exist.

**The two migrations deliberately do not name this decision.** They were originally keyed
`agent_tickets_retire_prioritized_lane_d076` and `agent_tickets_priority_from_epic_d076`, written
when this decision was mis-numbered D-076 (a number [[D-076]] already held on `main` — the exact
collision [[D-078]] exists to prevent). Renaming them to drop the id is not cosmetic: a migration
key is a **persisted ledger row**, not prose, and [[D-078]]'s numbering cycle rewrites every
`D-TMP-` citation with a blind `grep -rl`. Had the provisional id stayed in these keys, the cycle
would have silently renamed them *after* they had run in production — and a renamed key runs
again. `agent_tickets_priority_from_epic` re-cascades each Epic's priority over its members, so a
re-run would wipe every member priority set in the interim. **Never put a decision id — provisional
or final — in a migration key, a column name, or any other persisted identifier.** The citation
belongs in the comment above it, where a rewrite is free.

**Revisit if:** the Epic count passes ~100, where hand-ranking stops being credible and the ordinal
argument above stops holding; or if Tickets ever need to be dispatched outside an Epic, which would
reintroduce a Ticket-level priority and most of what this decision removes.