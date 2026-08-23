// Shared job-run record (PD-442). One row per execution of a scheduled job, written by any
// widget's cron via the run helper in apps/server/src/lib/job-runs.ts and read by the generic
// run surfaces (JobRunsList + /devops/jobs/[jobname]/[jobId]).
//
// This is deliberately cross-cutting rather than per-widget: the Ticket Audit, the BST scan,
// the BST drafter and the nightly DB backup all want the same three questions answered — did it
// run, did it work, what did it find — and answering them once is the whole point of the ticket.

/**
 * Two of these are not "did it work" answers, and both are here for the same reason: an outcome
 * the system knows belongs in the schema, not in prose.
 *
 * - `interrupted` — the server never got to finish this run. Not a job failure; counting the two
 *   together would let a week of deploys look like a week of breakage. It is also the one outcome
 *   whose duration is genuinely unknown (see `JobRun.finishedAt`).
 * - `partial` — the job ran and did some, but not all, of its work. Added for the r/modular scan
 *   (PD-471), whose contract is that a half-read week must never be reported as a clean one, but
 *   general to any job that processes a batch: some of N succeeded. Collapsing it into `ok` hides
 *   a degrading job; collapsing it into `error` overcounts failures and contradicts the widget's
 *   own readout, which shows the successful half.
 */
export const JOB_RUN_STATUSES = ['running', 'ok', 'error', 'partial', 'interrupted'] as const;
export type JobRunStatus = (typeof JOB_RUN_STATUSES)[number];

/** Shared job-run name for the nightly DB backup. Core, not a widget — hence it lives here. */
export const DB_BACKUP_JOB = 'db-backup';

/**
 * Did this run fail outright?
 *
 * False for `partial` (it did real work) and for `interrupted` (nobody knows what it would have
 * done). Both still want attention — use `isRunClean` for "nothing to look at here".
 */
export function isRunFailure(status: JobRunStatus): boolean {
  return status === 'error';
}

/** Did this run finish having done everything it set out to do? */
export function isRunClean(status: JobRunStatus): boolean {
  return status === 'ok';
}

/**
 * The job-defined headline payload for a run, stored as JSON.
 *
 * Deliberately untyped at this layer: the store must not know what a scan match or a draft is
 * (PD-442's "the component must not know what a scan match is" applies to the record too). Each
 * job narrows it at the point of use — `summary as BstScanSummary` in the caller that wrote it.
 */
export type JobRunSummary = Record<string, unknown>;

export interface JobRun {
  id: number;
  jobName: string;
  startedAt: number;
  /**
   * Null while the run is in flight.
   *
   * On an `interrupted` run this is when the restart was *detected*, not when the work stopped —
   * the true end time died with the process. Callers must not present it as a duration; see
   * `runDuration` in the web app, which returns null for exactly this reason.
   */
  finishedAt: number | null;
  status: JobRunStatus;
  /** The job's headline numbers. Null when the job supplied none, or when it failed early. */
  summary: JobRunSummary | null;
  /** Why the run ended badly — the failure on an `error` run, the cause on an `interrupted` one. */
  error: string | null;
}

export function isJobRunStatus(v: unknown): v is JobRunStatus {
  return typeof v === 'string' && (JOB_RUN_STATUSES as readonly string[]).includes(v);
}

/**
 * A run is finished when it is no longer `running`.
 *
 * Not the same as "succeeded" — an errored run is finished too. Callers that mean "worked"
 * should test `status === 'ok'` and say so.
 */
export function isRunFinished(run: JobRun): boolean {
  return run.status !== 'running';
}
