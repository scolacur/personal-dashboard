# D-086: The queue-model rules are enforced at the API boundary, and Reopen is a route (PD-542; amends D-083, implements D-080)

## Decision

The two rules that only the board enforced now hold against any HTTP caller:

- **Terminal is final** (D-083). A `PATCH` on a `completed`/`closed` Ticket refuses content
  edits and refuses to move it out of a terminal lane. Only `githubIssueNumber` and `archivedAt`
  remain writable — bookkeeping the record may gain after the fact, which changes nothing about what
  it says was done.
- **A Ticket never leaves its Epic** (D-080 / PD-509). `PATCH` refuses to clear `epic_id` on
  a Ticket that has one, and `POST` requires an Epic on create.

**Reopen becomes its own route** — `POST /tickets/:id/reopen` — and is the only sanctioned way out of
terminal. It enforces the obligations D-083 gave it: the Ticket must land in an Epic, and its
`agent_state` is cleared.

**The guards live at the route layer, not inside `updateTicket`.**

**The create-time Epic rule is global**, with no per-project opt-out.

## Why the route layer, not the store

The requirement is that the rules hold against a raw `curl`. The route layer *is* the untrusted
boundary; everything past it is the server's own orchestration, which is correct by construction and
should not have to ask permission. `createTicket`/`updateTicket` are called internally by
`approveRefine` — which legitimately closes a decomposed parent, i.e. enters terminal on purpose —
and by the recurrence respawn. Guarding the store would refuse the server's own correct behaviour and
force an exemption flag onto every internal call, which is a worse trade than guarding the door.

**The Robot loop is unaffected either way, and the original reasoning against this was wrong.**
D-083 declined server enforcement because "a server guard would have to distinguish the loop
from a human, which the API has no notion of." It does not have to: `apps/agent-worker` makes zero
HTTP calls and never imports `store.ts` — it opens `dashboard.db` directly and carries its own SQL.
The loop and the server are two independent writers on one table. Verified, not assumed: the
agent-worker suite is unchanged and green.

## What this is, and is not

**It is a guard, not an invariant.** It stops mistakes made through the API. It cannot stop the
loop's own SQL, and it is not a security boundary — the board is an unauthenticated LAN service, so
anyone who can reach the API can also reach the database file. Attribution of writes is a separate
concern, tracked as PD-543, and this decision does not depend on it: refusing a write and recording
who made it are different problems, and conflating them was what kept this ticket blocked.

## Why the create rule is global, and what had to happen first

The rule was briefly built with a per-project gate — enforce only where the project already has an
Epic — because PD-507 recorded that **Core had 23 active tickets and zero Epics**, so a blanket rule
would refuse every Core create with an instruction the caller could not follow.

**That gate was removed, because the prerequisite was met instead of designed around.** C-89 (*give
every active Core ticket an Epic*) was completed in the same pass: Core's Epic taxonomy already
existed (C-90…C-98, purpose-built for this backlog — 24 of the 25 tickets are named by id inside the
Epics' own bodies), and every active Core ticket was adopted into it. Both projects now report **zero
Epic-less active tickets**, so there is no project that cannot satisfy the rule.

Global is the better rule for a reason worth stating: a per-project gate makes the invariant a
function of history rather than a property of the model, and it fails silently in the direction that
matters — a brand-new project would quietly accept orphans until someone happened to create its
first Epic. The point of moving enforcement off the board was to stop rules holding only where
someone remembered to apply them.

## Consequences accepted

- **A Ticket cannot be removed from an Epic at all.** Active is refused by the Epic rule; terminal is
  refused by read-only, because a completed member's membership is part of what its Epic's roll-up
  counted — un-parenting it edits history rather than tidying it. Re-filing a finished Ticket means
  reopening it first. The member list's `×` was deleted rather than left to fail; it was the last
  orphan-creating surface, after slice B took the card kebab and the Archive-Epic unlink.
- **The recurrence respawn was a standing orphan factory** and is fixed here: it now carries
  `epicId` to the next occurrence. It created an Epic-less active Ticket on every recurrence, which
  no create-time guard would have caught, because the server was creating it itself.

## Deliberately not done

- **Enforcement inside the store.** See above; it would refuse the server's own correct writes.
- **Requiring an Epic on every edit.** Only *un-parenting* is refused. A legacy Ticket that never had
  an Epic stays editable — requiring one on every edit would enforce the model retroactively against
  history and break Core outright.
- **Anything about the loop's direct SQL writes.** Out of reach from here by design.
