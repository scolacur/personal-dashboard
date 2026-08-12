# D-073: A job run's outcome belongs in the schema, not in its message

**Date:** 2026-08-12 · **Tickets:** PD-442, PD-439, PD-440

## Context

The shared `job_runs` store (PD-442) began with three statuses — `running` / `ok` / `error` — on
the assumption that a job either works or fails. Two real cases immediately broke that, and both
were first implemented by encoding the cause in the `error` *text* while leaving the status
`error`.

1. **A run the server never finished.** Jobs run in-process on `node-cron`, so a row still marked
   `running` at boot belongs to a process that died. Left alone it renders as a spinner that never
   resolves.
2. **A run that did some of its work.** `runScan` (PD-471) catches per-thread failures on purpose,
   because half the week's offers beat none, and reports `partial` in its **return value** rather
   than throwing.

## Decision

Both are first-class statuses: `JOB_RUN_STATUSES = running | ok | error | partial | interrupted`,
with `isRunFailure` (only `error`) and `isRunClean` (only `ok`) beside them.

`recordRun` gained `ctx.setOutcome(status, error?)` so a job can report an outcome it **returned**
rather than threw. A throw still wins over a set outcome, being the later and more severe fact.

`runDuration` returns null for `interrupted`: its `finishedAt` is when the restart was *detected*,
not when the work stopped, so deriving a duration from it is a confident lie.

## Why

**A distinctive error message is not a queryable fact.** With the cause in prose, anything wanting
to count real failures had to string-match a sentence — the kind of check that rots silently — and
a week of deploys looked like a week of breakage.

**Collapsing `partial` in either direction loses something true.** Into `ok`, a degrading scanner
looks healthy, which is the exact failure PD-471's three-valued status exists to prevent. Into
`error`, failures are overcounted *and* the run row contradicts the widget's own readout, which
shows the successful half.

**Neither is a failure, so neither is red.** `partial` and `interrupted` are amber and orange; only
`error` is red. A page full of restarts must not read as a page full of breakage.

## Consequences

- Any job wrapping its cron in `recordRun` gets all five states for free.
- `partial` generalises past the scan — "some of N succeeded" is available to any batch job.
- The display layer must stay exhaustive over the union; the status→label and status→colour maps
  are `Record<JobRunStatus, …>`, so adding a status is a type error until it is handled.
- Superseded nothing. Amends no earlier decision — `job_runs` is new as of PD-442.
