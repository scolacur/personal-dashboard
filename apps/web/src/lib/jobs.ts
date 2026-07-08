// The dashboard's recurring background jobs (PD-286), surfaced in the Task Monitor "Jobs"
// section + /task-monitor/jobs. Kept in lockstep with the crons the server registers in
// apps/server/src/index.ts (task-monitor:audit + db-backup). `kind` picks the row renderer:
// 'audit' gets the rich row (live status, Run now, report link); everything else is schedule-only.

export type JobKind = 'audit' | 'backup';

export interface RecurringJob {
  id: string;
  name: string;
  description: string;
  /** 5-field cron expression, matching the server registration. */
  schedule: string;
  kind: JobKind;
  /** Report/detail route for jobs that have one (the audit). */
  reportRoute?: string;
}

export const RECURRING_JOBS: RecurringJob[] = [
  {
    id: 'ticket-audit',
    name: 'Ticket Audit',
    description: 'Autonomous advisory sweep of the backlog (D-045).',
    schedule: '0 5 * * 1', // AUDIT_SCHEDULE — weekly, Monday 05:00
    kind: 'audit',
    reportRoute: '/task-monitor/reports/ticket-audit',
  },
  {
    id: 'db-backup',
    name: 'Nightly DB Backup',
    description: 'Consistent snapshot of dashboard.db into the backups dir (PD-33).',
    schedule: '0 3 * * *', // daily 03:00
    kind: 'backup',
  },
];
