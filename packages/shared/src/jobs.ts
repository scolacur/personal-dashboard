// Shared job-run record (PD-442). One row per execution of a scheduled job, written by any
// widget's cron via the run helper in apps/server/src/lib/job-runs.ts and read by the generic
// run surfaces (JobRunsList + /devops/jobs/[jobname]/[jobId]).
//
// This is deliberately cross-cutting rather than per-widget: the Ticket Audit, the BST scan,
// the BST drafter and the nightly DB backup all want the same three questions answered — did it
// run, did it work, what did it find — and answering them once is the whole point of the ticket.

/**
 * `interrupted` is its own status rather than an `error` with a distinctive message.
 *
 * A run the server never got to finish is not a job that failed — counting the two together
 * would let a week of deploys look like a week of breakage, and telling them apart by
 * string-matching the error text is the kind of check that rots silently. It is also the one
 * outcome whose duration is genuinely unknown (see `JobRun.finishedAt`).
 */
export const JOB_RUN_STATUSES = ['running', 'ok', 'error', 'interrupted'] as const;
export type JobRunStatus = (typeof JOB_RUN_STATUSES)[number];

/** Did this run fail? An `interrupted` run did not — nobody knows what it would have done. */
export function isRunFailure(status: JobRunStatus): boolean {
  return status === 'error';
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
