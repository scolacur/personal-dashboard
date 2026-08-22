import type Database from 'better-sqlite3';

/**
 * On-demand maintenance job requests (PD-498) — the "Run now" button's queue.
 *
 * Separate from the hold row itself because a hold runs its registered jobs automatically; this
 * table only carries the *extra* runs a human asked for inside an open window. Keeping them apart
 * means the log can distinguish "the hold did its rounds" from "Steve pressed Run now", which is
 * the question you actually ask when reading it back.
 */

export interface MaintenanceJobRequest {
  id: number;
  holdId: number;
  jobName: string;
  requestedAt: number;
  claimedAt: number | null;
}

export function bootstrapMaintenanceJobRequestsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS maintenance_job_requests (
      id           INTEGER PRIMARY KEY,
      hold_id      INTEGER NOT NULL,
      job_name     TEXT    NOT NULL,
      requested_at INTEGER NOT NULL,
      claimed_at   INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_maintenance_job_requests_unclaimed
      ON maintenance_job_requests (claimed_at, requested_at);
  `);
}

/**
 * Ask for a job to run inside `holdId`.
 *
 * Idempotent per (hold, job) while unclaimed: pressing Run now twice in one window is one run, not
 * two. A second press after the first has been claimed does queue another, which is the honest
 * reading — the previous one is already over.
 */
export function requestMaintenanceJobRun(
  db: Database.Database,
  holdId: number,
  jobName: string,
  now: number = Date.now(),
): MaintenanceJobRequest {
  const existing = db
    .prepare('SELECT * FROM maintenance_job_requests WHERE hold_id = ? AND job_name = ? AND claimed_at IS NULL')
    .get(holdId, jobName) as
    | { id: number; hold_id: number; job_name: string; requested_at: number; claimed_at: number | null }
    | undefined;
  if (existing) {
    return {
      id: existing.id,
      holdId: existing.hold_id,
      jobName: existing.job_name,
      requestedAt: existing.requested_at,
      claimedAt: existing.claimed_at,
    };
  }
  const info = db
    .prepare('INSERT INTO maintenance_job_requests (hold_id, job_name, requested_at) VALUES (?, ?, ?)')
    .run(holdId, jobName, now);
  return { id: Number(info.lastInsertRowid), holdId, jobName, requestedAt: now, claimedAt: null };
}

/** Worker-only: take the next unclaimed request for this hold, marking it claimed. */
export function claimMaintenanceJobRun(
  db: Database.Database,
  holdId: number,
  now: number = Date.now(),
): MaintenanceJobRequest | null {
  const row = db
    .prepare(
      'SELECT * FROM maintenance_job_requests WHERE hold_id = ? AND claimed_at IS NULL ORDER BY requested_at ASC, id ASC LIMIT 1',
    )
    .get(holdId) as
    | { id: number; hold_id: number; job_name: string; requested_at: number; claimed_at: number | null }
    | undefined;
  if (!row) return null;
  db.prepare('UPDATE maintenance_job_requests SET claimed_at = ? WHERE id = ?').run(now, row.id);
  return { id: row.id, holdId: row.hold_id, jobName: row.job_name, requestedAt: row.requested_at, claimedAt: now };
}
