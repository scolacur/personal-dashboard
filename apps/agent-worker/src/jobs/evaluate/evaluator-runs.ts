import type Database from 'better-sqlite3';
import type { EvaluatorFinding, EvaluatorReport, EvaluatorVerdict } from '@dashboard/shared';
import { evaluateBudget, type BudgetPolicy, type BudgetUsage, type BudgetVerdict } from '../robot/budget';

/**
 * `evaluator_runs` — the Evaluator's own spend ledger (PD-487, [[D-076]]).
 *
 * **A separate table, not a row in `agent_runs`, and that is the whole point of the ticket.** PD-487
 * requires the Evaluator to run "on a budget that is not the run's", and `budgetUsage()` (PD-463)
 * sums `turns`/`tokens` over **every** row in `agent_runs` with no discriminator. Writing evaluation
 * spend there would make the Evaluator count against the Robot loop's dispatch ceiling — so
 * reviewing a PR could pause dispatch, and a busy review day would look identical to a runaway
 * coding loop. Worse, it would mean the act of judging a run inflates the very number used to decide
 * whether that run was affordable.
 *
 * A filter on a `kind` column would have worked too, and would have been one forgotten `WHERE` away
 * from silently reintroducing the coupling. A separate table cannot be got wrong by omission.
 *
 * Worker-owned, same as `agent_runs` and `robot_state`: `CREATE TABLE IF NOT EXISTS` on boot, no
 * server import, no migration file.
 */

export interface EvaluatorRun {
  id: number;
  ticketId: number;
  prNumber: number;
  round: number;
  verdict: EvaluatorVerdict | null;
  findings: EvaluatorFinding[];
  summary: string | null;
  turns: number | null;
  tokens: number | null;
  model: string | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

/** Idempotent schema bootstrap — safe on every boot. */
export function ensureEvaluatorRunsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS evaluator_runs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id    INTEGER NOT NULL,
      pr_number    INTEGER NOT NULL,
      round        INTEGER NOT NULL,
      verdict      TEXT,
      findings     TEXT,
      summary      TEXT,
      turns        INTEGER,
      tokens       INTEGER,
      model        TEXT,
      error        TEXT,
      started_at   INTEGER NOT NULL,
      finished_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_evaluator_runs_ticket ON evaluator_runs (ticket_id, started_at);
  `);
}

/** Open a run row and return its id. Written BEFORE the agent starts so a crashed evaluation leaves
 *  evidence rather than nothing — the same reason `agent_runs` claims a row up front. */
export function startEvaluatorRun(
  db: Database.Database,
  input: { ticketId: number; prNumber: number; round: number; model: string },
  now: number = Date.now(),
): number {
  const res = db
    .prepare(
      `INSERT INTO evaluator_runs (ticket_id, pr_number, round, model, started_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.ticketId, input.prNumber, input.round, input.model, now);
  return Number(res.lastInsertRowid);
}

/** Close a run with its verdict, or with an error when the evaluation could not be read. */
export function finishEvaluatorRun(
  db: Database.Database,
  runId: number,
  outcome: { report?: EvaluatorReport; error?: string; turns?: number; tokens?: number },
  now: number = Date.now(),
): void {
  db.prepare(
    `UPDATE evaluator_runs
        SET verdict = ?, findings = ?, summary = ?, turns = ?, tokens = ?, error = ?, finished_at = ?
      WHERE id = ?`,
  ).run(
    outcome.report?.verdict ?? null,
    outcome.report ? JSON.stringify(outcome.report.findings) : null,
    outcome.report?.summary ?? null,
    outcome.turns ?? null,
    outcome.tokens ?? null,
    outcome.error ?? null,
    now,
    runId,
  );
}

/**
 * How many times this ticket's CURRENT review cycle has been evaluated.
 *
 * Counted from `since` — the caller passes the last hand-off boundary, the same boundary
 * `decideReactivation` uses. That is what makes the round cap per-review-cycle rather than
 * per-ticket-lifetime: a ticket a human sends back for genuinely new reasons months later gets a
 * fresh pair of rounds, while a Robot⇄Evaluator ping-pong inside one cycle still terminates.
 */
export function evaluationRounds(db: Database.Database, ticketId: number, since = 0): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM evaluator_runs WHERE ticket_id = ? AND started_at >= ?`)
    .get(ticketId, since) as { n: number };
  return row.n;
}

/** Whether this exact PR has already been evaluated at or after `since` — the idempotence guard that
 *  stops a poll tick from re-evaluating the same unchanged hand-off. */
export function alreadyEvaluated(db: Database.Database, ticketId: number, prNumber: number, since: number): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM evaluator_runs
        WHERE ticket_id = ? AND pr_number = ? AND started_at >= ?`,
    )
    .get(ticketId, prNumber, since) as { n: number };
  return row.n > 0;
}

/** The Evaluator's spend inside its own rolling window. Mirrors `budgetUsage()` over its own table —
 *  deliberately the same shape so `evaluateBudget()` is reused rather than re-derived. */
export function evaluatorBudgetUsage(db: Database.Database, since: number): BudgetUsage {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(turns), 0) AS turns, COALESCE(SUM(tokens), 0) AS tokens, COUNT(*) AS runs
         FROM evaluator_runs
        WHERE COALESCE(finished_at, started_at) >= ?`,
    )
    .get(since) as { turns: number; tokens: number; runs: number };
  return { turns: row.turns, tokens: row.tokens, runs: row.runs };
}

/** Has the Evaluator exhausted its own ceiling for the window? */
export function evaluatorBudgetVerdict(
  db: Database.Database,
  policy: BudgetPolicy,
  now: number = Date.now(),
): BudgetVerdict {
  return evaluateBudget(evaluatorBudgetUsage(db, now - policy.windowMs), policy);
}

/** Newest first — for the ticket detail view and for tests. */
export function recentEvaluatorRuns(db: Database.Database, ticketId: number, limit = 10): EvaluatorRun[] {
  const rows = db
    .prepare(
      `SELECT id, ticket_id, pr_number, round, verdict, findings, summary, turns, tokens, model, error,
              started_at, finished_at
         FROM evaluator_runs WHERE ticket_id = ? ORDER BY started_at DESC, id DESC LIMIT ?`,
    )
    .all(ticketId, limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as number,
    ticketId: r.ticket_id as number,
    prNumber: r.pr_number as number,
    round: r.round as number,
    verdict: (r.verdict as EvaluatorVerdict | null) ?? null,
    findings: parseFindings(r.findings as string | null),
    summary: (r.summary as string | null) ?? null,
    turns: (r.turns as number | null) ?? null,
    tokens: (r.tokens as number | null) ?? null,
    model: (r.model as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    startedAt: r.started_at as number,
    finishedAt: (r.finished_at as number | null) ?? null,
  }));
}

function parseFindings(raw: string | null): EvaluatorFinding[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as EvaluatorFinding[]) : [];
  } catch {
    return [];
  }
}
