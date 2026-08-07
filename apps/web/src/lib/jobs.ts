// The dashboard's recurring background jobs (PD-286), surfaced in the Dev Ops "Jobs"
// section + /devops/jobs. Kept in lockstep with the crons the server registers in
// apps/server/src/index.ts (task-monitor:audit + db-backup). `kind` picks the row renderer:
// 'audit' gets the rich row (live status, Run now, report link); everything else is schedule-only.

export type JobKind = 'audit' | 'backup';

/**
 * A job's declaration that it writes `job_runs` rows (PD-442) — which is all it takes to get a
 * run list on the Jobs surfaces and a working detail page, with no new UI code.
 *
 * This replaces `kind === 'audit'` as the way a job earns a rich row: `kind` picks the row
 * *renderer*, this declares the job *has history*. The audit keeps its bespoke row until it is
 * migrated onto the shared store (PD-443).
 */
export interface JobRunHistory {
  /** The `job_name` the server writes runs under — the key both API routes take. */
  jobName: string;
  /**
   * Optional richer report page for one run, overriding the generic
   * `/devops/jobs/<jobname>/<runId>` route. This is how the Ticket Audit keeps its findings
   * report once it moves onto the shared store.
   */
  detailHref?: (runId: number) => string;
  /** How many runs to show inline on a job row. */
  limit?: number;
}

export interface RecurringJob {
  id: string;
  name: string;
  description: string;
  /** 5-field cron expression, matching the server registration. */
  schedule: string;
  kind: JobKind;
  /** Report/detail route for jobs that have one (the audit). */
  reportRoute?: string;
  /** Set when this job records runs in the shared `job_runs` store (PD-442). */
  runs?: JobRunHistory;
}

export const RECURRING_JOBS: RecurringJob[] = [
  {
    id: 'ticket-audit',
    name: 'Ticket Audit',
    description: 'Autonomous advisory sweep of the backlog (D-045).',
    schedule: '0 5 * * 1', // AUDIT_SCHEDULE — weekly, Monday 05:00
    kind: 'audit',
    reportRoute: '/devops/reports/ticket-audit',
  },
  {
    id: 'db-backup',
    name: 'Nightly DB Backup',
    description: 'Consistent snapshot of dashboard.db into the backups dir (PD-33).',
    schedule: '0 3 * * *', // daily 03:00
    kind: 'backup',
  },
];
