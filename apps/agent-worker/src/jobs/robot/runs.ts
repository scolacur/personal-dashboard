import type Database from 'better-sqlite3';

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
  | 'error'; // the coding session itself failed (spawn/SDK/crash)

export const RUN_STATUSES: readonly RunStatus[] = ['running', 'handed-off', 'no-verify', 'error'];

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
  startedAt: number;
  finishedAt: number | null;
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
        SET status = ?, session_id = ?, pr_url = ?, error = ?, finished_at = ?
      WHERE id = ?`,
  ).run(input.status, input.sessionId ?? null, input.prUrl ?? null, input.error ?? null, now, runId);
}

/** How many runs a ticket has accumulated — the raw signal C2's retry cap reads. */
export function runCountForTicket(db: Database.Database, ticketId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM agent_runs WHERE ticket_id = ?')
    .get(ticketId) as { n: number };
  return row.n;
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
