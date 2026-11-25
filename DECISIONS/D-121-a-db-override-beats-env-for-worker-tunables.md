# D-121: A DB override beats the env var for worker tunables; the env var stays the boot default (PD-1006)

**Date:** 2026-11-24 · **Ticket:** PD-1006 ([Dev Ops] Configuration page: view and edit the agent-worker's tunable settings without editing the env file) · **Epic:** PD-495 ([Epic] Dev Ops Configuration page) · **Shape settled in:** PD-511 ([Dev Ops] Runtime toggles: enable/disable each agent type + Robot concurrency, without a recreate) · **Related:** [[D-055]] (`robot_state` and the DB-read dispatch pause), [[D-103]] (`capacity_policy`, the worker publishing what the web process can't read)

## Context

Every agent-worker tunable (budgets, poll intervals, caps, thresholds) was env-only. Changing one meant SSHing into the NAS, editing `agent-worker.env` and recreating the container. On 2026-11-24 the Evaluator hit `EVALUATOR_BUDGET_TURNS` (800/day, 810 used) and quietly stopped reviewing PRs. The PRs piled up until someone did the hand edit and a restart.

PD-495 left open whether a GUI for these values implies a recreate. PD-511 answered that for its toggles by pointing at the precedent that already works: `robot_state.dispatch_paused`, a DB flag the loop reads every cycle. This decision makes that the rule for every worker tunable.

## Decision

1. **Effective value = DB override ?? env var ?? code default.** The env var is the boot default and is never written by the web process. A row in `config_overrides` wins when present. Clearing the row (Reset) falls straight back to the env value.
2. **One registry, in `packages/shared` (`WORKER_SETTINGS`).** Each entry holds the env name, label, group, unit, code default, min/max, a description, `live`, and `readBy` (`worker` or `server`). The page, the server's validation and the worker all read it. Only keys in the registry can be stored (the routes 404 anything else) or returned. That is how secrets, tokens, paths, the repo, bot identity, proxy and URLs are kept out: they are never registered.
3. **One override store: the `config_overrides` table** (`key`, TEXT `value`, `updated_at`), created by the server's schema bootstrap. The worker only reads it and treats a missing table as "no overrides". `value` is TEXT so PD-511's boolean toggles fit without a second store. PD-511 adds registry entries and worker accessors; it does not build its own table.
4. **Live vs restart.** A `live` setting is re-read on every pass: `effectiveConfig(db, config)` runs at the top of the Robot cycle, the Evaluator pass, the conflict and visual passes, and each Refine tick. That covers every budget and cap, so an Evaluator or Robot budget change applies on the next pass. Intervals that arm a `setInterval` at boot are `live: false`. Their override is taken once at startup (`startupConfig`), and the page says "applies on worker restart". Re-arming timers was not worth the complexity. The two intervals that are throttled inside their pass (conflicts, visual) are live.
5. **The worker publishes what it booted with.** The web process can't read the worker's env. So on startup the worker writes `robot_state.worker_config_boot`: each setting's env/default value, its source, and the value it actually started with. This is the same precedent as `capacity_policy` and `budget_policy`. The page shows the env value beside the override. A restart-only override that the running worker hasn't applied yet is flagged as pending restart, so the page never shows a value as in force when it isn't.
6. **Validated twice.** The server refuses a non-integer or out-of-bounds value with a 400 that names the setting and the bounds. The worker re-validates each row on read and ignores (and logs once) a row the current bounds reject, so a stale or hand-written row can't set a cap to something the registry forbids.
7. **Server-read tunables use the same store.** The `AUTO_QUEUE_*` limits are read by the web process (`autoQueueLimits(db)`), with the same precedence.

## Consequences

- No container restart, docker socket, or env-file write from the web process. This keeps the PD-495 path-guard concern contained: the page edits DB rows, never deploy/infra files.
- A boot value shows as "not reported" until the worker restarts on an image with this change.
- Adding a tunable means a registry entry, plus (for worker settings) an accessor in `effective-config.ts`. A parity spec fails if `config.ts` doesn't read the env var into the field the accessor names, or if the defaults drift.
