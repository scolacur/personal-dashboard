import type Database from 'better-sqlite3';
import type { HoldStatus, HoldTrigger, MaintenanceHold, MaintenanceHoldRun } from '@dashboard/shared';

/**
 * The maintenance-hold log and request queue (PD-498, extends D-078).
 *
 * Cross-cutting infrastructure like `job-runs.ts`, so it lives in `apps/server/src/lib/` rather
 * than inside a widget (PROJECT.md §5). Both processes touch it, and the split matters:
 *
 *   - the **web process** only ever *requests* a hold (inserting a `queued` row) and reads the log;
 *   - the **agent-worker** owns every state transition after that, because it is the only process
 *     that knows whether Robot runs have drained.
 *
 * That is the same DB-as-the-queue coordination the Robot loop already uses (D-055) — the button in
 * Dev Ops writes a row, it does not call the worker.
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

export function bootstrapMaintenanceHoldsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS maintenance_holds (
      id           INTEGER PRIMARY KEY,
      trigger      TEXT    NOT NULL,
      status       TEXT    NOT NULL,
      requested_at INTEGER NOT NULL,
      started_at   INTEGER,
      ended_at     INTEGER,
      note         TEXT
    );

    /* Every read is "the log, newest first" or "is one open right now". */
    CREATE INDEX IF NOT EXISTS idx_maintenance_holds_requested
      ON maintenance_holds (requested_at DESC);
    CREATE INDEX IF NOT EXISTS idx_maintenance_holds_status
      ON maintenance_holds (status, requested_at);

    /* Which job runs happened inside which hold. A join table rather than a hold_id column on
       job_runs: job_runs is generic infrastructure shared by widgets that know nothing about
       maintenance, and it should not grow a column for this one consumer (D-074). */
    CREATE TABLE IF NOT EXISTS maintenance_hold_runs (
      hold_id    INTEGER NOT NULL,
      job_run_id INTEGER NOT NULL,
      PRIMARY KEY (hold_id, job_run_id)
    );
  `);
}

function rowToHold(r: HoldRow, runs: MaintenanceHoldRun[]): MaintenanceHold {
  return {
    id: r.id,
    trigger: r.trigger as HoldTrigger,
    status: r.status as HoldStatus,
    requestedAt: r.requested_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    note: r.note,
    runs,
  };
}

function runsFor(db: Database.Database, holdIds: number[]): Map<number, MaintenanceHoldRun[]> {
  const byHold = new Map<number, MaintenanceHoldRun[]>();
  if (holdIds.length === 0) return byHold;
  const rows = db
    .prepare(
      `SELECT hr.hold_id AS hold_id, r.id AS id, r.job_name AS job_name, r.status AS status,
              r.started_at AS started_at, r.finished_at AS finished_at
         FROM maintenance_hold_runs hr
         JOIN job_runs r ON r.id = hr.job_run_id
        WHERE hr.hold_id IN (${holdIds.map(() => '?').join(',')})
        ORDER BY r.started_at DESC`,
    )
    .all(...holdIds) as {
    hold_id: number;
    id: number;
    job_name: string;
    status: string;
    started_at: number;
    finished_at: number | null;
  }[];
  for (const r of rows) {
    const list = byHold.get(r.hold_id) ?? [];
    list.push({ jobRunId: r.id, jobName: r.job_name, status: r.status, startedAt: r.started_at, finishedAt: r.finished_at });
    byHold.set(r.hold_id, list);
  }
  return byHold;
}

/** The hold log, newest first, each with the job runs it contained. */
export function listHolds(db: Database.Database, limit = 20): MaintenanceHold[] {
  const rows = db
    .prepare('SELECT * FROM maintenance_holds ORDER BY requested_at DESC, id DESC LIMIT ?')
    .all(limit) as HoldRow[];
  const runs = runsFor(db, rows.map((r) => r.id));
  return rows.map((r) => rowToHold(r, runs.get(r.id) ?? []));
}

/** The hold currently holding dispatch, or null. */
export function activeHold(db: Database.Database): MaintenanceHold | null {
  const row = db.prepare("SELECT * FROM maintenance_holds WHERE status = 'active' ORDER BY id DESC LIMIT 1").get() as
    | HoldRow
    | undefined;
  if (!row) return null;
  return rowToHold(row, runsFor(db, [row.id]).get(row.id) ?? []);
}

/** The oldest hold waiting to start, or null. */
export function nextQueuedHold(db: Database.Database): MaintenanceHold | null {
  const row = db
    .prepare("SELECT * FROM maintenance_holds WHERE status = 'queued' ORDER BY requested_at ASC, id ASC LIMIT 1")
    .get() as HoldRow | undefined;
  return row ? rowToHold(row, []) : null;
}

/**
 * Ask for a hold. Returns the hold that will satisfy the request.
 *
 * **Idempotent against an existing request**: if one is already `queued`, that row is returned
 * rather than a second being created. Pressing the button twice means "I want a hold", not "I want
 * two holds", and a queue of duplicates would hold dispatch open repeatedly for no reason.
 *
 * A hold is *not* deduplicated against an `active` one — see `requestHoldOrJoinActive` in the route
 * layer for why joining the open window is the right answer there instead.
 */
export function requestHold(db: Database.Database, trigger: HoldTrigger, now: number = Date.now()): MaintenanceHold {
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

/** Worker-only: the drain finished, dispatch is held. */
export function startHold(db: Database.Database, holdId: number, now: number = Date.now()): void {
  db.prepare("UPDATE maintenance_holds SET status = 'active', started_at = ? WHERE id = ?").run(now, holdId);
}

/** Worker-only: the window closed. `abandoned` is for a hold that never got to start. */
export function endHold(
  db: Database.Database,
  holdId: number,
  status: Extract<HoldStatus, 'completed' | 'abandoned'>,
  note: string | null = null,
  now: number = Date.now(),
): void {
  db.prepare('UPDATE maintenance_holds SET status = ?, ended_at = ?, note = ? WHERE id = ?').run(status, now, note, holdId);
}

/** Worker-only: record that a job run belongs to this hold. */
export function attachRunToHold(db: Database.Database, holdId: number, jobRunId: number): void {
  db.prepare('INSERT OR IGNORE INTO maintenance_hold_runs (hold_id, job_run_id) VALUES (?, ?)').run(holdId, jobRunId);
}

/** When the last hold that actually started did so — what the daily cadence is measured from. */
export function lastHoldStartedAt(db: Database.Database): number | null {
  const row = db
    .prepare('SELECT MAX(started_at) AS t FROM maintenance_holds WHERE started_at IS NOT NULL')
    .get() as { t: number | null };
  return row.t;
}

/**
 * Close out holds left `active` or `queued` by a process that died.
 *
 * Called at worker start. An `active` row whose window has already elapsed is not holding anything
 * — the worker's own hold state lapses on its deadline (D-TMP-PD498a) — so leaving it `active`
 * would show the Dev Ops nav a hold that does not exist.
 */
export function closeStaleHolds(db: Database.Database, windowMs: number, now: number = Date.now()): number {
  const info = db
    .prepare(
      `UPDATE maintenance_holds
          SET status = 'abandoned', ended_at = ?, note = 'closed at startup — the worker restarted mid-hold'
        WHERE status = 'active' AND started_at < ?`,
    )
    .run(now, now - windowMs);
  return info.changes;
}
