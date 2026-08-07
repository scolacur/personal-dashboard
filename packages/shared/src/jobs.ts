// Shared job-run record (PD-442). One row per execution of a scheduled job, written by any
// widget's cron via the run helper in apps/server/src/lib/job-runs.ts and read by the generic
// run surfaces (JobRunsList + /devops/jobs/[jobname]/[jobId]).
//
// This is deliberately cross-cutting rather than per-widget: the Ticket Audit, the BST scan,
// the BST drafter and the nightly DB backup all want the same three questions answered — did it
// run, did it work, what did it find — and answering them once is the whole point of the ticket.

export const JOB_RUN_STATUSES = ['running', 'ok', 'error'] as const;
export type JobRunStatus = (typeof JOB_RUN_STATUSES)[number];

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
  /** Null while the run is in flight. */
  finishedAt: number | null;
  status: JobRunStatus;
  /** The job's headline numbers. Null when the job supplied none, or when it failed early. */
  summary: JobRunSummary | null;
  /** The failure reason on an `error` run; null otherwise. */
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
