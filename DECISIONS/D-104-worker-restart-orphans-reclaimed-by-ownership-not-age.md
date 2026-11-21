# D-104: Worker-restart orphans are reclaimed by ownership, not age; graceful interrupts never count, unclean restarts count against their own cap and a restart breaker

**Status:** accepted
**Date:** 2026-11-21
**Ticket:** PD-784 (Robot run t946)
**Amends:** the age-based stall reconciler (C5/PD-346); builds on the fault guardrail (D-055/PD-343) and PD-736's WIP preservation.

## Context

Recreating the `agent-worker` container sends SIGTERM, waits out the stop-grace period, then sends
SIGKILL. Before this decision the worker had no SIGTERM handler, and node running as PID 1 ignores
SIGTERM by default, so every recreation SIGKILLed it at Docker's 10s default. A run in flight was
left `running` with its ticket `working`. The stall reconciler judged such a row dead by **age
alone**: it was reclaimed only once its `started_at` was older than `ROBOT_STALL_THRESHOLD_MS`
(default 2h). Until then the ticket sat in `working`, which `robotQueueCandidates` never re-picks,
and the maintenance hold's drain check (`inFlightRunCount`) counted it as in flight, so no hold
could open. On 2026-11-20 this stranded runs for about 1.5h. Dispatch slots are not computed from
`running` rows, so other tickets could still dispatch.

PD-736's WIP push runs in a `finally` that a SIGKILLed process never reaches, so the killed run's
work was also lost.

Today (`ROBOT_CONCURRENCY = 1`) the loop awaits each session inside the cycle, and the reconciler
runs at cycle start, so the live process never owns a run when the reconciler looks. Concurrency is
expected to rise, and once a run can outlive the cycle that started it, an age test would also close
a **live** run older than 2h and dispatch its ticket twice.

## Decision

1. **Reclaim by ownership, not age.** The live worker keeps an in-memory registry of the run ids it
   is executing (`ownership.ts`). A `running` row the registry does not hold was opened by an earlier
   incarnation. It is a **process-restart orphan** and is reclaimed on the first cycle, whatever its
   age. A row the registry does hold is never treated as an orphan. The age threshold survives only
   as a **hung-session backstop**, measured from the **last reported turn**. The backstop aborts the
   session with reason `hung`, so the loop knows the run is already closed and does not close it
   again. With today's sequential, awaited dispatch the owned branches cannot fire: a hung session
   blocks the whole cycle, reconciler included, and nothing detects it. They are kept and tested for
   when runs outlive a cycle.

2. **Drain on SIGTERM.** The entrypoint's stop handler stops new dispatch and aborts in-flight
   sessions through the SDK `abortController`, using reason `shutdown`. `runRobotSession` catches the
   SDK's abort error and *returns* `{ ok: false }` rather than throwing, so the loop checks the
   controller's abort reason on both exits of the session, not only in its `catch`. An aborted run
   closes as a transient **`interrupted`** fault after a time-boxed WIP push. A session that finished
   its hand-off, or asked its question, before the abort landed keeps that outcome.
   `stop_grace_period` is raised to 30s so the 20s drain fits.

3. **`interrupted` never counts.** It always re-queues immediately and is excluded from the retry
   budget and from promotion. With `promoteAfter = 2`, two deploys during one ticket's runs would
   otherwise park it.

4. **`process-restart-orphan` counts against its own cap.** Once the graceful stop works, a routine
   deploy leaves no orphan. An orphan now means the worker died uncleanly: an OOM kill, a crash, a
   host reboot, or SIGKILL after the grace period. That is a real signal, and the session may be
   what killed the worker. Orphans stay out of the ordinary retry budget, so one reboot doesn't burn
   a real-fault retry. They count against a separate per-ticket **orphan cap** (`ROBOT_ORPHAN_CAP`,
   default 3, reset by a human reset like every other count). Reaching the cap parks the ticket.
   Without the cap, a session that OOMs the worker would crash-loop it forever under
   `restart: unless-stopped`. The cap is above 1 so that, once concurrency is above 1, a sibling run
   lost to another ticket's OOM can survive a couple of such deaths.

5. **A restart breaker covers unclean restarts not tied to one ticket.** Every incarnation whose
   reconciler reclaims at least one orphan records one unclean restart in `robot_state`. The record
   is keyed by the incarnation's start time, so one death that orphans several runs still counts
   once. When `ROBOT_RESTART_BREAKER_COUNT` restarts (default 4) fall within
   `ROBOT_RESTART_BREAKER_WINDOW_MS` (default 6h), dispatch pauses through the durable pause (D-072)
   and a loop notification is raised. Resuming is a human act. The default is one above the orphan
   cap, so a single bad ticket parks itself before it can trip the whole loop. This is the
   worker-owned circuit breaker D-103 calls for, scoped to process deaths.

## Alternatives considered

- **Record the worker instance id on each run row and compare in SQL.** Equivalent for the orphan
  test, but it needs a schema column and still cannot answer "is this run making progress?", which
  the hung-session backstop needs. The in-memory registry answers both and adds no column.
- **Keep age-based reclaim but shorten the threshold.** Any fixed age is simultaneously too long for
  a restart (should be instant) and too short for a healthy long run (should be never). Ownership is
  the property that actually distinguishes the two cases.
- **Count infra faults like ordinary transients.** Rejected: two unrelated deploys or reboots during
  one ticket's runs would park it.
- **Never count restart orphans.** Rejected: a session that kills the worker would re-queue for free
  forever, and `restart: unless-stopped` turns that into a crash loop.
- **Make the deploy wait for in-flight runs to finish (a maintenance-hold drain).** That is PD-561's
  area and a heavier change; this ticket makes an *interrupted* stop safe, which is the floor.

## Consequences

- Orphans clear on the first cycle after a restart, with no 2h wait. Their tickets return to the
  queue, and the maintenance hold's drain check stops counting them.
- A deploy no longer loses WIP, strands a ticket, or uses up its retry budget.
- A ticket whose runs keep dying with the worker parks after 3. Repeated unclean restarts pause the
  loop.
- Hung-session detection stays unsolved while sessions are awaited inside the cycle. A per-run
  watchdog timer would fix that, and is out of scope here.
- Other agent-worker jobs (Refine, Evaluator, conflicts, visual, maintenance) get no drain. The
  process exits once the Robot drains or after 20s, whichever comes first; before this change those
  jobs were SIGKILLed at 10s. Whether they leave durable in-flight state behind is not addressed here.
