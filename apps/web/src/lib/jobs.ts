// The dashboard's recurring background jobs (PD-286), surfaced in the Dev Ops "Jobs"
// section + /devops/jobs. Kept in lockstep with the crons the server registers — core ones in
// apps/server/src/index.ts (db-backup), the rest in each widget's `registerCron`.
//
// `kind` picks the row *renderer*: 'audit' gets the bespoke rich row (live status, Run now,
// report link) until PD-443 migrates it; everything else gets the standard row. Since PD-442 it
// is `runs` — not `kind` — that decides whether a job shows history, which is why new jobs are
// plain 'generic' rather than growing this union one entry per job.

export type JobKind = 'audit' | 'backup' | 'generic';

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
  {
    id: 'bst-scan',
    name: 'BST — r/modular scan',
    description:
      'Reads the two newest r/modular Buy/Sell/Trade threads over public RSS and matches ' +
      'comments against the gear list (PD-471). About two minutes — the feed allows roughly ' +
      'one request a minute.',
    schedule: '0 9 * * 1', // BST_SCAN_SCHEDULE — weekly, Monday 09:00
    kind: 'generic',
    runs: { jobName: 'buy-sell-trade:scan' },
  },
  {
    id: 'bst-drafts',
    name: 'BST — monthly post drafter',
    description:
      'Renders the Reddit, Facebook and Discord versions of the for-sale post from the current ' +
      'gear list and terms (PD-439). Adds a batch; never overwrites last month’s.',
    schedule: '0 9 15 * *', // BST_DRAFTS_SCHEDULE — monthly, the 15th at 09:00
    kind: 'generic',
    runs: { jobName: 'buy-sell-trade:drafts' },
  },
];
