import type Database from 'better-sqlite3';
import type { HoldKind } from '@dashboard/shared';

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

/* ── Session-limit hold (PD-470) ───────────────────────────────────────────────
 * A provider session limit is an ACCOUNT-wide condition with a stated end time, so it is neither a
 * ticket fault nor a human-cleared pause: the loop holds, then resumes itself. Kept separate from
 * `dispatch_paused` on purpose — a hold expires on its own, a pause never does, and collapsing the
 * two would mean either a quota blip needing a human or an auth outage silently self-resuming
 * (the PD-320/#202 failure mode `dispatch_paused` exists to prevent).
 */

const SESSION_LIMIT_HOLD = 'session_limit_until';

export interface SessionLimitHold {
  /** Which condition is being waited out (PD-248). Rows written before it carried no kind and are
   *  read as 'session-limit', which is what they were. */
  kind: HoldKind;
  /** Epoch ms the loop may dispatch again. */
  until: number;
  /** The fault text that caused the hold, for the UI and the log. */
  reason: string;
  /** Epoch ms the hold was set. */
  since: number;
}

/** The stored hold, whether or not it has expired — `null` when none is set. Pure read (the server
 *  calls this for the status API and must not mutate worker state). */
export function sessionLimitHold(db: Database.Database): SessionLimitHold | null {
  const row = db.prepare('SELECT value, updated_at FROM robot_state WHERE key = ?').get(SESSION_LIMIT_HOLD) as
    | { value: string | null; updated_at: number }
    | undefined;
  if (!row || row.value === null) return null;
  try {
    const parsed = JSON.parse(row.value) as { until?: unknown; reason?: unknown; kind?: unknown };
    if (typeof parsed.until !== 'number') return null;
    return {
      kind: parsed.kind === 'github-rate-limit' ? 'github-rate-limit' : 'session-limit',
      until: parsed.until,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      since: row.updated_at,
    };
  } catch {
    return null; // a hand-edited / corrupt row must not wedge the loop shut
  }
}

/** Hold dispatch until `until`. A later hold WINS (unlike `pauseDispatch`, which keeps the first
 *  reason): a second session limit means the provider moved the goalposts, and the newer reset time
 *  is the accurate one. */
export function holdForSessionLimit(
  db: Database.Database,
  until: number,
  reason: string,
  now: number = Date.now(),
  kind: HoldKind = 'session-limit',
): void {
  writeState(db, SESSION_LIMIT_HOLD, JSON.stringify({ until, reason, kind }), now);
}

/** Clear the hold. */
export function clearSessionLimitHold(db: Database.Database, now: number = Date.now()): void {
  db.prepare(
    `INSERT INTO robot_state (key, value, updated_at) VALUES (?, NULL, ?)
       ON CONFLICT(key) DO UPDATE SET value = NULL, updated_at = excluded.updated_at`,
  ).run(SESSION_LIMIT_HOLD, now);
}

/** The cycle gate: the hold if it is still in force, or `null` — **clearing an expired hold as it
 *  goes**, so the loop resumes with no human action and the state doesn't linger to confuse the UI.
 *  This self-clearing read is the whole point of PD-470: on 2026-07-28 a session-limit park outlived
 *  its cause by ~12h (quota reset at 1:30 AM, the ticket sat until the afternoon). */
export function activeSessionLimitHold(db: Database.Database, now: number = Date.now()): SessionLimitHold | null {
  const hold = sessionLimitHold(db);
  if (!hold) return null;
  if (now < hold.until) return hold;
  clearSessionLimitHold(db, now);
  return null;
}

/* ── Maintenance hold (D-081, D-082) ───────────────────────────────────────────
 * The hold a maintenance job takes so it can work on shared files without racing a Robot that is
 * mid-run against the same tree.
 *
 * Its original subscriber was the decision-numbering cycle, deleted by PD-560 when ids became
 * allocated at authoring time (D-088). The hold itself is deliberately kept: it is the general
 * machinery for that problem, and the hard parts — draining, bounding the window, releasing safely
 * on every exit path — are not worth re-deriving the next time something needs it.
 *
 * ## Why this is a SEPARATE key, and not a third `kind` on the session-limit hold
 *
 * D-078 called it "a third kind on the existing hold, not new machinery", and that reads right
 * until you notice `session_limit_until` is ONE k/v slot with last-writer-wins semantics. Sharing
 * it breaks in both directions, and both are silent:
 *
 *   - A provider session limit arriving mid-cycle overwrites the maintenance hold. `until` moves to
 *     the quota reset and the *reason* changes, so when that expires the loop resumes dispatch while
 *     the cycle is still rewriting files underneath it.
 *   - Worse in reverse: the cycle finishes and releases "the hold", nulling a session-limit hold
 *     that arrived while it ran. Dispatch resumes straight into a spent quota — the exact PD-470
 *     failure, reintroduced.
 *
 * Two conditions with independent causes and independent lifetimes need two slots. This is the same
 * rule D-077 applied to memory files: one owner per slot, so a release only ever clears what its
 * owner set. The `kind` still exists — for DISPLAY, so the dashboard can say which condition is in
 * force — but it is not what keeps the two apart.
 *
 * The gate reads both. `until` is a bound, not a schedule: the cycle releases the hold explicitly
 * when it finishes, and the expiry exists only so a cycle that dies mid-run cannot wedge dispatch
 * shut forever.
 */

const MAINTENANCE_HOLD = 'maintenance_hold';

export interface MaintenanceHold {
  /** Epoch ms the hold lapses on its own — a DEADLINE, not a plan. See `takeMaintenanceHold`. */
  until: number;
  /** What is holding dispatch, for the UI and the log. */
  reason: string;
  /** Epoch ms the hold was taken. */
  since: number;
}

/** The stored maintenance hold, expired or not — `null` when none is set. Pure read, so the server
 *  can render it in the status API without mutating worker state. */
export function maintenanceHold(db: Database.Database): MaintenanceHold | null {
  const row = db.prepare('SELECT value, updated_at FROM robot_state WHERE key = ?').get(MAINTENANCE_HOLD) as
    | { value: string | null; updated_at: number }
    | undefined;
  if (!row || row.value === null) return null;
  try {
    const parsed = JSON.parse(row.value) as { until?: unknown; reason?: unknown };
    if (typeof parsed.until !== 'number') return null;
    return {
      until: parsed.until,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      since: row.updated_at,
    };
  } catch {
    return null; // a corrupt row must not wedge the loop shut
  }
}

/**
 * Take the hold. `until` is the deadline past which it lapses **whatever happened to the holder** —
 * the numbering cycle passes `now + stallThresholdMs`, the same bound a stalled run gets, because a
 * cycle that dies between taking the hold and releasing it must not stop dispatch indefinitely.
 *
 * A second take WINS, and is the normal way to extend a long-running cycle's deadline.
 */
export function takeMaintenanceHold(db: Database.Database, until: number, reason: string, now: number = Date.now()): void {
  writeState(db, MAINTENANCE_HOLD, JSON.stringify({ until, reason }), now);
}

/** Release the hold. Clears ONLY this slot — never the session-limit hold, which has its own owner. */
export function releaseMaintenanceHold(db: Database.Database, now: number = Date.now()): void {
  db.prepare(
    `INSERT INTO robot_state (key, value, updated_at) VALUES (?, NULL, ?)
       ON CONFLICT(key) DO UPDATE SET value = NULL, updated_at = excluded.updated_at`,
  ).run(MAINTENANCE_HOLD, now);
}

/** The dispatch gate: the hold if it is still in force, or `null` — clearing a lapsed one as it goes,
 *  exactly like {@link activeSessionLimitHold}, so a dead cycle self-heals with no human. */
export function activeMaintenanceHold(db: Database.Database, now: number = Date.now()): MaintenanceHold | null {
  const hold = maintenanceHold(db);
  if (!hold) return null;
  if (now < hold.until) return hold;
  releaseMaintenanceHold(db, now);
  return null;
}

/** Upsert an arbitrary `robot_state` key (C5/PD-346 — used to throttle the PR-state poll). */
export function writeState(db: Database.Database, key: string, value: string, now: number = Date.now()): void {
  db.prepare(
    `INSERT INTO robot_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now);
}

/** Read a `robot_state` value as a number, or 0 when absent/unset/non-numeric. */
export function readStateNumber(db: Database.Database, key: string): number {
  const row = db.prepare('SELECT value FROM robot_state WHERE key = ?').get(key) as { value: string | null } | undefined;
  if (!row || row.value === null) return 0;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : 0;
}
