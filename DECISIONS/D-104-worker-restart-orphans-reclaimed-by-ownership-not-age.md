# D-104: Worker-restart orphans and graceful interrupts are infra faults — reclaimed by ownership, never counted against the retry budget

**Status:** accepted
**Date:** 2026-11-21
**Ticket:** PD-784 (Robot run t946)
**Amends:** the age-based stall reconciler (C5/PD-346); builds on the fault guardrail (D-055/PD-343) and PD-736's WIP preservation.

## Context

A deploy recreates the `agent-worker` container: SIGTERM → stop-grace → SIGKILL. On 2026-11-20 one
such recreation killed four in-flight Robot runs. The new worker booted healthy but **dispatched
nothing for ~1.5h**, because the stall reconciler decided "is this `running` row dead?" from **age
alone**: a run was reclaimed only once its `started_at` was older than `ROBOT_STALL_THRESHOLD_MS`
(default 2h). So each orphan sat out the full two hours from its own start — filling every run slot —
even though the process that started it was provably gone the instant the container was recreated.

The same age test is wrong in the other direction now that runs are concurrent and a run can outlive
the cycle that started it: a run of the **live** process that legitimately passes 2h would be closed
as an orphan and its ticket re-queued *while the session is still working*, i.e. dispatched twice.
The reconciler's own docstring still claimed "no session of this process is in flight at a cycle
boundary", which stopped being true when dispatch stopped being strictly sequential.

Separately, PD-736's WIP push runs in a `finally` that a SIGKILLed container never reaches, so a
deploy also **lost the work** of every run it killed.

## Decision

1. **Reclaim by ownership, not age.** The live worker keeps an in-memory registry of the run ids it
   is executing (`ownership.ts`). A `running` row the registry does not hold was opened by a previous
   incarnation — a **process-restart orphan** — and is reclaimed on the first cycle, whatever its
   age. A row it does hold is never an orphan; the age threshold survives only as a **hung-session
   backstop**, measured from the **last reported turn**, not `started_at`, so a session still making
   progress is never touched. In-memory is correct precisely because the one fact a restart destroys
   is "which runs was the dead process executing" — and after a restart the answer is "none", which
   is what makes every pre-existing `running` row an orphan.

2. **A restart orphan and a graceful interrupt are *infrastructure* faults, not ticket faults.** They
   get their own signatures (`process-restart-orphan`, `interrupted`) that **always re-queue
   immediately** and are **never counted or promoted** (`countable()` and `decideFault()` in
   `faults.ts`). This is the load-bearing half of the decision: the incident had four deploys in an
   hour, and with `promoteAfter = 2` a ticket interrupted by two of them would otherwise be promoted
   to a deterministic **park** for a deploy it had nothing to do with. Infra events are like a session
   limit in blame (not the ticket's fault) but unlike it in remedy (run again *now*, don't hold).

3. **Drain on SIGTERM instead of dying under SIGKILL.** The entrypoint installs a stop handler that
   asks the Robot loop to stop dispatching and aborts its in-flight sessions (the SDK `abortController`).
   Each aborted session unwinds through the loop's existing failure path, which closes the run as a
   transient `interrupted` fault **after a time-boxed WIP push** — so a graceful stop leaves nothing
   `running`, and the next boot's ownership sweep finds no orphan and never dispatches a ticket twice.
   The compose `stop_grace_period` is raised to 30s so the drain fits.

## Alternatives considered

- **Record the worker instance id on each run row and compare in SQL.** Equivalent for the orphan
  test, but it needs a schema column and still cannot answer "is this run making progress?", which
  the hung-session backstop needs. The in-memory registry answers both and adds no column.
- **Keep age-based reclaim but shorten the threshold.** Any fixed age is simultaneously too long for
  a restart (should be instant) and too short for a healthy long run (should be never). Ownership is
  the property that actually distinguishes the two cases.
- **Count infra faults like ordinary transients.** Rejected: it re-introduces the exact failure the
  fix exists to prevent — a burst of deploys stranding tickets in a park.
- **Make the deploy wait for in-flight runs to finish (a maintenance-hold drain).** That is PD-561's
  area and a heavier change; this ticket makes an *interrupted* stop safe, which is the floor.

## Consequences

- Orphans clear on the first post-restart cycle; no 2h dead zone.
- A healthy long run is never reclaimed; only a genuinely hung one is (and its zombie session is
  aborted when it is).
- A deploy no longer loses WIP or strands tickets.
- The hung-session backstop can, in a truly concurrent future, re-dispatch a ticket whose owned
  session hung — the ticket's accepted trade-off for recovering from a hang; the old session is
  aborted to make that safe.
