import type Database from 'better-sqlite3';

/**
 * The worker's half of the "Run now" request queue (PD-498). Schema owned by the web process —
 * see the note in `holds-db.ts`.
 */

export interface MaintenanceJobRequest {
  id: number;
  holdId: number;
  jobName: string;
  requestedAt: number;
}

/** Take the next unclaimed request for this hold, marking it claimed so a second tick cannot
 *  double-run it. Claim-then-run, not run-then-claim: a crash mid-job must not replay it. */
export function claimMaintenanceJobRun(
  db: Database.Database,
  holdId: number,
  now: number,
): MaintenanceJobRequest | null {
  const row = db
    .prepare(
      'SELECT * FROM maintenance_job_requests WHERE hold_id = ? AND claimed_at IS NULL ORDER BY requested_at ASC, id ASC LIMIT 1',
    )
    .get(holdId) as { id: number; hold_id: number; job_name: string; requested_at: number } | undefined;
  if (!row) return null;
  db.prepare('UPDATE maintenance_job_requests SET claimed_at = ? WHERE id = ?').run(now, row.id);
  return { id: row.id, holdId: row.hold_id, jobName: row.job_name, requestedAt: row.requested_at };
}
