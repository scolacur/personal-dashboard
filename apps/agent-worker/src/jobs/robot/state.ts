import type Database from 'better-sqlite3';

/**
 * `robot_state` — a tiny key/value store for the Robot loop's own durable flags (D-055, PD-343).
 * The only key today is `dispatch_paused`: set when a **system-wide** fault (auth/credit) is
 * detected, so the loop stops dispatching WITHOUT burning any ticket's retry budget. It is durable
 * on purpose — an auth outage must stay paused across a worker restart until a human clears it
 * (auto-resuming on restart would silently re-burn the board, the PD-320/#202 failure mode). C4
 * builds the resume UI on top of `resumeDispatch` / `dispatchPauseState`.
 *
 * Worker-owned, same as `agent_runs`: `CREATE TABLE IF NOT EXISTS` on boot, no server import.
 */

const DISPATCH_PAUSED = 'dispatch_paused';

export interface DispatchPauseState {
  paused: boolean;
  reason: string | null;
  since: number | null;
}

/** Idempotent schema bootstrap — safe to call on every boot. */
export function ensureRobotStateTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS robot_state (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at INTEGER NOT NULL
    );
  `);
}

/** Read the loop-wide dispatch-pause flag. */
export function dispatchPauseState(db: Database.Database): DispatchPauseState {
  const row = db.prepare('SELECT value, updated_at FROM robot_state WHERE key = ?').get(DISPATCH_PAUSED) as
    | { value: string | null; updated_at: number }
    | undefined;
  if (!row || row.value === null) return { paused: false, reason: null, since: null };
  return { paused: true, reason: row.value, since: row.updated_at };
}

/** Convenience predicate for the dispatch gate. */
export function isDispatchPaused(db: Database.Database): boolean {
  return dispatchPauseState(db).paused;
}

/** Pause the whole loop with a reason. Idempotent — a later pause keeps the FIRST reason/timestamp
 *  so the original trigger isn't overwritten by a follow-on cycle before a human sees it. */
export function pauseDispatch(db: Database.Database, reason: string, now: number = Date.now()): void {
  db.prepare(
    `INSERT INTO robot_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
       WHERE robot_state.value IS NULL`,
  ).run(DISPATCH_PAUSED, reason, now);
}

/** Clear the pause (the C4 resume action). */
export function resumeDispatch(db: Database.Database, now: number = Date.now()): void {
  db.prepare(
    `INSERT INTO robot_state (key, value, updated_at) VALUES (?, NULL, ?)
       ON CONFLICT(key) DO UPDATE SET value = NULL, updated_at = excluded.updated_at`,
  ).run(DISPATCH_PAUSED, now);
}
