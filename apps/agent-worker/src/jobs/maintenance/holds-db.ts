import type Database from 'better-sqlite3';
import type { HoldStatus, HoldTrigger, MaintenanceHold } from '@dashboard/shared';

/**
 * The worker's half of the maintenance-hold tables (PD-498).
 *
 * **The schema is owned and bootstrapped by the web process**, in
 * `apps/server/src/lib/maintenance-holds.ts`. This file deliberately does not re-declare the DDL:
 * two `CREATE TABLE IF NOT EXISTS` statements for one table is a drift bug waiting to happen, and
 * the server always runs — it is the dashboard. If the worker boots first, {@link holdsTablesReady}
 * is false and the coordinator no-ops until the tables appear, which is a benign wait rather than a
 * race over who defines the columns.
 *
 * The same two processes already split `robot_state` this way: each writes its own SQL against a
 * shared DB, neither imports the other.
 */

interface HoldRow {
  id: number;
  trigger: string;
  status: string;
  requested_at: number;
  started_at: number | null;
  ended_at: number | null;
  note: string | null;
}

/** Whether the web process has created the hold tables yet. */
export function holdsTablesReady(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('maintenance_holds', 'maintenance_hold_runs', 'maintenance_job_requests')")
    .get() as { n: number };
  return row.n === 3;
}

function rowToHold(r: HoldRow): MaintenanceHold {
  return {
    id: r.id,
    trigger: r.trigger as HoldTrigger,
    status: r.status as HoldStatus,
    requestedAt: r.requested_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    note: r.note,
    runs: [],
  };
}

export function activeHold(db: Database.Database): MaintenanceHold | null {
  const row = db.prepare("SELECT * FROM maintenance_holds WHERE status = 'active' ORDER BY id DESC LIMIT 1").get() as
    | HoldRow
    | undefined;
  return row ? rowToHold(row) : null;
}

export function nextQueuedHold(db: Database.Database): MaintenanceHold | null {
  const row = db
    .prepare("SELECT * FROM maintenance_holds WHERE status = 'queued' ORDER BY requested_at ASC, id ASC LIMIT 1")
    .get() as HoldRow | undefined;
  return row ? rowToHold(row) : null;
}

/** Queue a hold. The worker does this for the daily cadence; the web process does it for the button. */
export function requestHold(db: Database.Database, trigger: HoldTrigger, now: number): MaintenanceHold {
  const existing = nextQueuedHold(db);
  if (existing) return existing;
  const info = db
    .prepare("INSERT INTO maintenance_holds (trigger, status, requested_at) VALUES (?, 'queued', ?)")
    .run(trigger, now);
  return {
    id: Number(info.lastInsertRowid),
    trigger,
    status: 'queued',
    requestedAt: now,
    startedAt: null,
    endedAt: null,
    note: null,
    runs: [],
  };
}

export function startHold(db: Database.Database, holdId: number, now: number): void {
  db.prepare("UPDATE maintenance_holds SET status = 'active', started_at = ? WHERE id = ?").run(now, holdId);
}

export function endHold(
  db: Database.Database,
  holdId: number,
  status: Extract<HoldStatus, 'completed' | 'abandoned'>,
  note: string | null,
  now: number,
): void {
  db.prepare('UPDATE maintenance_holds SET status = ?, ended_at = ?, note = ? WHERE id = ?').run(status, now, note, holdId);
}

export function attachRunToHold(db: Database.Database, holdId: number, jobRunId: number): void {
  db.prepare('INSERT OR IGNORE INTO maintenance_hold_runs (hold_id, job_run_id) VALUES (?, ?)').run(holdId, jobRunId);
}

/** When the last hold that actually STARTED did so — what the cadence is measured from. */
export function lastHoldStartedAt(db: Database.Database): number | null {
  const row = db
    .prepare('SELECT MAX(started_at) AS t FROM maintenance_holds WHERE started_at IS NOT NULL')
    .get() as { t: number | null };
  return row.t;
}
