import type Database from 'better-sqlite3';
import type { FailedRun, FaultTier } from './faults';

/**
 * `agent_runs` — one row per **run** (a single Robot attempt on a ticket; D-055 glossary).
 * The Robot loop is the sole writer. This is the durable record the fault guardrail (C2)
 * counts attempts from and the observability timeline (C3) reads — so it is written even for
 * failed/errored runs, never only on success.
 *
 * Owned by this job (the audit job owns its tables the same way): the worker `CREATE TABLE
 * IF NOT EXISTS` on boot rather than importing the server's store. C3 adds the read side +
 * UI on top of this same table.
 */

/** How a run ended. `pending` while in flight; terminal states are set by finishRun. */
export type RunStatus =
  | 'running'
  | 'handed-off' // green verify → pushed branch + PR (the success path)
  | 'no-verify' // turn ended before a green verify → WIP left for retry (D-046 gate)
  | 'ask-human' // the Robot posted a question and parked (awaiting-human) — not a failure (C2)
  | 'error'; // the coding session itself failed (spawn/SDK/crash)

export const RUN_STATUSES: readonly RunStatus[] = ['running', 'handed-off', 'no-verify', 'ask-human', 'error'];

export interface RunRow {
  id: number;
  ticketId: number;
  /** GitHub issue number the run targeted, when the ticket is linked (else null). */
  issueNumber: number | null;
  branch: string;
  status: RunStatus;
  /** The Robot's session id (from the coding SDK session), for cross-referencing logs. */
  sessionId: string | null;
  prUrl: string | null;
  error: string | null;
  /** C2 fault classification of a failed run (null for successes / older rows). */
  faultTier: FaultTier | null;
  faultSignature: string | null;
  faultReason: string | null;
  /** C3 observability metrics off the SDK result (null for older rows / no result). */
  turns: number | null;
  tokens: number | null;
  startedAt: number;
  finishedAt: number | null;
}

/** Add a column only if it isn't already present — additive migration for a table that already
 *  exists on the NAS (CREATE IF NOT EXISTS won't alter an existing table). */
function addColumnIfMissing(db: Database.Database, table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

/** Idempotent schema bootstrap — safe to call on every boot. */
export function ensureRunsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id    INTEGER NOT NULL,
      issue_number INTEGER,
      branch       TEXT NOT NULL,
      status       TEXT NOT NULL,
      session_id   TEXT,
      pr_url       TEXT,
      error        TEXT,
      started_at   INTEGER NOT NULL,
      finished_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runs_ticket ON agent_runs (ticket_id, started_at);
  `);
  // C2 (PD-343) fault-tier columns — added post-hoc so an existing NAS table migrates in place.
  addColumnIfMissing(db, 'agent_runs', 'fault_tier', 'TEXT');
  addColumnIfMissing(db, 'agent_runs', 'fault_signature', 'TEXT');
  addColumnIfMissing(db, 'agent_runs', 'fault_reason', 'TEXT');
  // C3 (PD-344) observability metrics.
  addColumnIfMissing(db, 'agent_runs', 'turns', 'INTEGER');
  addColumnIfMissing(db, 'agent_runs', 'tokens', 'INTEGER');
}

export interface StartRunInput {
  ticketId: number;
  issueNumber: number | null;
  branch: string;
}

/** Open a `running` run row and return its id — call before the coding session starts. */
export function startRun(
  db: Database.Database,
  input: StartRunInput,
  now: number = Date.now(),
): number {
  const res = db
    .prepare(
      `INSERT INTO agent_runs (ticket_id, issue_number, branch, status, started_at)
       VALUES (?, ?, ?, 'running', ?)`,
    )
    .run(input.ticketId, input.issueNumber, input.branch, now);
  return Number(res.lastInsertRowid);
}

export interface FinishRunInput {
  status: Exclude<RunStatus, 'running'>;
  sessionId?: string | null;
  prUrl?: string | null;
  error?: string | null;
  /** C2 fault classification, for a failed run. */
  faultTier?: FaultTier | null;
  faultSignature?: string | null;
  faultReason?: string | null;
  /** C3 observability metrics off the SDK result. */
  turns?: number | null;
  tokens?: number | null;
}

/** Close out a run with its terminal outcome. */
export function finishRun(
  db: Database.Database,
  runId: number,
  input: FinishRunInput,
  now: number = Date.now(),
): void {
  db.prepare(
    `UPDATE agent_runs
        SET status = ?, session_id = ?, pr_url = ?, error = ?,
            fault_tier = ?, fault_signature = ?, fault_reason = ?,
            turns = ?, tokens = ?, finished_at = ?
      WHERE id = ?`,
  ).run(
    input.status,
    input.sessionId ?? null,
    input.prUrl ?? null,
    input.error ?? null,
    input.faultTier ?? null,
    input.faultSignature ?? null,
    input.faultReason ?? null,
    input.turns ?? null,
    input.tokens ?? null,
    now,
    runId,
  );
}

/** How many runs a ticket has accumulated — the raw signal C2's retry cap reads. */
export function runCountForTicket(db: Database.Database, ticketId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM agent_runs WHERE ticket_id = ?')
    .get(ticketId) as { n: number };
  return row.n;
}

/**
 * A ticket's FAILED runs as the fault engine (faults.ts) needs them — the `no-verify` and `error`
 * runs only (`ask-human` is a park, not a failure; successes don't count). A missing `fault_tier`
 * (a pre-C2 row) is treated as `transient`, the safe/retryable default.
 */
export function failedRunsForTicket(db: Database.Database, ticketId: number): FailedRun[] {
  const rows = db
    .prepare(
      `SELECT fault_tier, fault_signature, status, finished_at
         FROM agent_runs
        WHERE ticket_id = ? AND status IN ('no-verify', 'error')
        ORDER BY started_at ASC, id ASC`,
    )
    .all(ticketId) as { fault_tier: string | null; fault_signature: string | null; status: string; finished_at: number | null }[];
  return rows.map((r) => ({
    tier: (r.fault_tier as FaultTier | null) ?? 'transient',
    signature: r.fault_signature ?? r.status,
    finishedAt: r.finished_at ?? null,
  }));
}

function rowToRun(r: Record<string, unknown>): RunRow {
  return {
    id: r.id as number,
    ticketId: r.ticket_id as number,
    issueNumber: (r.issue_number as number | null) ?? null,
    branch: r.branch as string,
    status: r.status as RunStatus,
    sessionId: (r.session_id as string | null) ?? null,
    prUrl: (r.pr_url as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    faultTier: (r.fault_tier as FaultTier | null) ?? null,
    faultSignature: (r.fault_signature as string | null) ?? null,
    faultReason: (r.fault_reason as string | null) ?? null,
    turns: (r.turns as number | null) ?? null,
    tokens: (r.tokens as number | null) ?? null,
    startedAt: r.started_at as number,
    finishedAt: (r.finished_at as number | null) ?? null,
  };
}

/** A ticket's runs, newest first — the C3 timeline source. */
export function listRunsForTicket(db: Database.Database, ticketId: number): RunRow[] {
  const rows = db
    .prepare('SELECT * FROM agent_runs WHERE ticket_id = ? ORDER BY started_at DESC, id DESC')
    .all(ticketId) as Record<string, unknown>[];
  return rows.map(rowToRun);
}
