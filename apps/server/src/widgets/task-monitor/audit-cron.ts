import type Database from 'better-sqlite3';
import type { CronLogger, CronRegistry } from '../../cron';
import { insertRequestedRunIfNone } from './audit-store';

// Weekly Ticket Audit trigger (D-045, PD-283). The cron only ENQUEUES a run row; the
// agent-worker claims and executes it. Mon 05:00 keeps it off the weekday-morning path.
export const AUDIT_SCHEDULE = process.env.AUDIT_SCHEDULE ?? '0 5 * * 1';

export function registerAuditJob(cron: CronRegistry, log: CronLogger, db: Database.Database): void {
  cron.register('task-monitor:audit', AUDIT_SCHEDULE, () => {
    const { run, created } = insertRequestedRunIfNone(db, null);
    log.info(
      created
        ? `audit: enqueued weekly run ${run.id}`
        : `audit: run ${run.id} already pending/running — skipped`,
    );
  });
}
