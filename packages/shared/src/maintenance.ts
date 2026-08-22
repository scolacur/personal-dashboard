/**
 * The maintenance hold and the jobs that run inside it (PD-498, extends D-078).
 *
 * ## The hold is the scheduled thing; jobs subscribe to it
 *
 * D-078 shipped the decision-consolidation cycle as a self-scheduling job that *took* a hold as an
 * implementation detail. That inverts here: the **hold** is the recurring event, and a maintenance
 * job declares that it runs during one. The reason is that the expensive, risky part is not the
 * work — it is the window: draining in-flight Robot runs, holding dispatch, and releasing safely
 * whatever happens. A second maintenance job should inherit all of that rather than re-derive it.
 */

/** Why a hold exists. `manual` is the Dev Ops button; `scheduled` is the daily cadence. */
export type HoldTrigger = 'scheduled' | 'manual';

/**
 * Where a hold is in its life.
 *
 * `queued` is the state that makes the manual button honest: pressed while Robots are working, the
 * hold cannot start, so it waits rather than failing. That is also why a queued hold is allowed
 * even when one ran recently — the human asked for it.
 */
export type HoldStatus = 'queued' | 'active' | 'completed' | 'abandoned';

export interface MaintenanceHold {
  id: number;
  trigger: HoldTrigger;
  status: HoldStatus;
  /** When it was asked for — for a scheduled hold, when the cadence came due. */
  requestedAt: number;
  /** When dispatch was actually held: null while still queued. */
  startedAt: number | null;
  /** When the hold was released. */
  endedAt: number | null;
  /** Why it ended, when that is worth saying — e.g. a drain that never completed. */
  note: string | null;
  /** The `job_runs` rows produced inside this hold, newest first. */
  runs: MaintenanceHoldRun[];
}

/** One job run that happened inside a hold — the join the hold log renders. */
export interface MaintenanceHoldRun {
  jobRunId: number;
  jobName: string;
  status: string;
  startedAt: number;
  finishedAt: number | null;
}

/**
 * How long a hold stays open once it starts.
 *
 * A hold with no job left to run releases immediately — this is the ceiling, not the plan. It
 * exists because "Run now" is only enabled *during* a hold, which means a human can hold dispatch
 * open while they decide what to press. Thirty minutes is long enough to use and short enough that
 * walking away costs one window rather than a day of dispatch.
 */
export const HOLD_WINDOW_MS = 30 * 60_000;

/** How often a hold comes due on its own. Daily, carried over from D-078's cycle cadence. */
export const HOLD_CADENCE_MS = 24 * 60 * 60_000;

/** A maintenance job's identity, shared by the worker that runs it and the UI that lists it. */
export interface MaintenanceJob {
  /** The `job_runs.job_name` it records under, and the key its API routes take. */
  jobName: string;
  name: string;
  description: string;
}

/**
 * The maintenance jobs, in the order a hold runs them.
 *
 * One entry today. It lives in `shared` rather than in the worker so the Dev Ops page can render
 * the section without duplicating the list — the same reason the decision index has one parser.
 */
export const MAINTENANCE_JOBS: MaintenanceJob[] = [
  {
    jobName: 'decisions:consolidation',
    name: 'Decision Consolidation',
    description:
      'Assigns a D-NNN to every decision in DECISIONS/incoming/ in merge order, rewrites their ' +
      'D-TMP- citations repo-wide, regenerates DECISIONS.md, and merges the result (D-078).',
  },
];

/** Whether a hold is holding dispatch right now. */
export function isHoldActive(hold: MaintenanceHold | null): boolean {
  return hold?.status === 'active';
}
