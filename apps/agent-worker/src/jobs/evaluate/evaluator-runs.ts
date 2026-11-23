import type Database from 'better-sqlite3';
import type { EvaluatorLens } from '@dashboard/shared';
import type { EvaluatorFinding, EvaluatorReport, EvaluatorVerdict } from '@dashboard/shared';
import { evaluateBudget, type BudgetPolicy, type BudgetUsage, type BudgetVerdict } from '../robot/budget';
import { MAX_EVALUATION_ROUNDS } from './verdict';

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
  // PD-767: which reviewer the run belongs to. Existing rows predate the security lens, so they are
  // code reviews by definition — hence the default.
  const cols = db.prepare('PRAGMA table_info(evaluator_runs)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'lens')) {
    db.exec("ALTER TABLE evaluator_runs ADD COLUMN lens TEXT NOT NULL DEFAULT 'code'");
  }
  // PD-712: the head commit a review of a non-Robot PR judged, so a new push is a new review. Robot
  // runs leave it null: their cycle is bounded by hand-offs instead (see reviewBoundary).
  if (!cols.some((c) => c.name === 'head_sha')) {
    db.exec('ALTER TABLE evaluator_runs ADD COLUMN head_sha TEXT');
  }
}

/** `ticket_id` for a review of a PR with no linked ticket (PD-712). The column predates such PRs and
 *  is NOT NULL; no ticket has id 0. */
export const NO_TICKET = 0;

/** Whether this exact head of a non-Robot PR has been reviewed (PD-712). */
export function headEvaluated(db: Database.Database, prNumber: number, headSha: string): boolean {
  return (
    (db
      .prepare("SELECT COUNT(*) AS n FROM evaluator_runs WHERE pr_number = ? AND head_sha = ? AND lens = 'code'")
      .get(prNumber, headSha) as { n: number }).n > 0
  );
}

/** How many heads of a non-Robot PR have been reviewed by this lens: its round count (PD-712). */
export function prRounds(db: Database.Database, prNumber: number, lens: EvaluatorLens = 'code'): number {
  return (db
    .prepare('SELECT COUNT(*) AS n FROM evaluator_runs WHERE pr_number = ? AND head_sha IS NOT NULL AND lens = ?')
    .get(prNumber, lens) as { n: number }).n;
}

/** Open a run row and return its id. Written BEFORE the agent starts so a crashed evaluation leaves
 *  evidence rather than nothing — the same reason `agent_runs` claims a row up front. */
export function startEvaluatorRun(
  db: Database.Database,
  input: { ticketId: number; prNumber: number; round: number; model: string; lens?: EvaluatorLens; headSha?: string },
  now: number = Date.now(),
): number {
  const res = db
    .prepare(
      `INSERT INTO evaluator_runs (ticket_id, pr_number, round, model, started_at, lens, head_sha) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.ticketId, input.prNumber, input.round, input.model, now, input.lens ?? 'code', input.headSha ?? null);
  return Number(res.lastInsertRowid);
}

/**
 * PD-909: record live progress on a still-open evaluation. Scoped to `finished_at IS NULL` so a
 * late callback can never overwrite the authoritative totals `finishEvaluatorRun` writes, and
 * `COALESCE` so an unknown token total never blanks a known one. One statement per turn.
 */
export function updateEvaluatorRunProgress(db: Database.Database, runId: number, turns: number, tokens?: number): void {
  db.prepare(
    'UPDATE evaluator_runs SET turns = ?, tokens = COALESCE(?, tokens) WHERE id = ? AND finished_at IS NULL',
  ).run(turns, tokens ?? null, runId);
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
export function evaluationRounds(db: Database.Database, ticketId: number, since = 0, lens: EvaluatorLens = 'code'): number {
  // PD-767: counted per lens, so two reviewers on one PR do not reach the round cap twice as fast.
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM evaluator_runs WHERE ticket_id = ? AND started_at >= ? AND lens = ?`)
    .get(ticketId, since, lens) as { n: number };
  return row.n;
}

/**
 * How many no-verdict (errored) runs a lens may have in one review cycle before it is "done" (PD-883):
 * the original run plus its single retry. SEPARATE from `MAX_EVALUATION_ROUNDS` (the revise
 * ping-pong limit) so an error retry never silently consumes a legitimate revise round.
 */
export const MAX_LENS_ERROR_RUNS = 2;

/** Per-lens state over the runs of one review unit (PD-883). */
export interface LensRunState {
  /** Runs that produced a verdict (ship / revise / escalate). */
  verdictRuns: number;
  /** Runs that produced no verdict — an agent error or an unparseable reply. */
  errorRuns: number;
  /** A terminal verdict (ship or escalate) was recorded — the lens is settled whatever its round. */
  hasTerminalVerdict: boolean;
}

/**
 * How the runs of one review unit are selected (PD-883). The unit differs by path:
 *  - the **Robot** path's unit is the review cycle since the last hand-off — its runs leave `head_sha`
 *    null, so they are keyed on `ticketId` + `prNumber` with `started_at >= since` (`reviewBoundary`);
 *  - the **non-Robot** path's unit is a single head commit — keyed on `prNumber` + `head_sha`.
 * Both reduce to the same per-lens `{verdictRuns, errorRuns, hasTerminalVerdict}`.
 */
export type LensRunSelect =
  | { ticketId: number; prNumber: number; since: number }
  | { prNumber: number; headSha: string };

function lensRunRows(db: Database.Database, select: LensRunSelect): { lens: string | null; verdict: string | null }[] {
  return (
    'headSha' in select
      ? db
          .prepare('SELECT lens, verdict FROM evaluator_runs WHERE pr_number = ? AND head_sha = ?')
          .all(select.prNumber, select.headSha)
      : db
          .prepare('SELECT lens, verdict FROM evaluator_runs WHERE ticket_id = ? AND pr_number = ? AND started_at >= ?')
          .all(select.ticketId, select.prNumber, select.since)
  ) as { lens: string | null; verdict: string | null }[];
}

/** Per-lens evaluation state over a review unit's runs (PD-883). */
export function lensStates(db: Database.Database, select: LensRunSelect): Map<EvaluatorLens, LensRunState> {
  const map = new Map<EvaluatorLens, LensRunState>();
  for (const r of lensRunRows(db, select)) {
    const lens = (r.lens ?? 'code') as EvaluatorLens;
    const s = map.get(lens) ?? { verdictRuns: 0, errorRuns: 0, hasTerminalVerdict: false };
    if (r.verdict === null) {
      s.errorRuns += 1;
    } else {
      s.verdictRuns += 1;
      if (r.verdict === 'ship' || r.verdict === 'escalate') s.hasTerminalVerdict = true;
    }
    map.set(lens, s);
  }
  return map;
}

/**
 * Whether a lens still needs an evaluation run in this cycle (PD-883). It does NOT when it is settled:
 * it has a terminal verdict (ship/escalate), it has revised up to the round cap, or it has used its
 * one error retry. A lens with a single errored run and no verdict is NOT settled — it is retried on
 * a later poll. A revise below the cap is not settled either, so the revise ping-pong keeps running
 * to `MAX_EVALUATION_ROUNDS` (in production that re-engagement moves the ticket out of in-review).
 */
export function lensNeedsRun(state: LensRunState | undefined): boolean {
  if (!state) return true;
  if (state.hasTerminalVerdict) return false;
  if (state.errorRuns >= MAX_LENS_ERROR_RUNS) return false;
  if (state.verdictRuns >= MAX_EVALUATION_ROUNDS) return false;
  return true;
}

/** The latest verdict-bearing run for a lens in a review unit, as a report (PD-883). Used to FOLD a
 *  lens that already decided this cycle into the combined decision without re-running it. */
export function latestLensReport(db: Database.Database, select: LensRunSelect, lens: EvaluatorLens): EvaluatorReport | null {
  const row = (
    'headSha' in select
      ? db
          .prepare(
            `SELECT verdict, findings, summary FROM evaluator_runs
              WHERE pr_number = ? AND head_sha = ? AND lens = ? AND verdict IS NOT NULL
              ORDER BY started_at DESC, id DESC LIMIT 1`,
          )
          .get(select.prNumber, select.headSha, lens)
      : db
          .prepare(
            `SELECT verdict, findings, summary FROM evaluator_runs
              WHERE ticket_id = ? AND pr_number = ? AND started_at >= ? AND lens = ? AND verdict IS NOT NULL
              ORDER BY started_at DESC, id DESC LIMIT 1`,
          )
          .get(select.ticketId, select.prNumber, select.since, lens)
  ) as { verdict: string; findings: string | null; summary: string | null } | undefined;
  if (!row) return null;
  return {
    verdict: row.verdict as EvaluatorVerdict,
    findings: parseFindings(row.findings),
    summary: row.summary ?? '',
  };
}

/**
 * Whether this PR has been fully evaluated for its current review cycle — the idempotence guard that
 * stops a poll tick re-evaluating an unchanged hand-off (PD-883). True when EVERY enabled lens is
 * settled (has a verdict, or has used its one error retry); false while any lens still owes a run,
 * so an errored lens is re-evaluated on a later poll rather than stranding the PR.
 */
export function alreadyEvaluated(
  db: Database.Database,
  ticketId: number,
  prNumber: number,
  since: number,
  lenses: EvaluatorLens[] = ['code'],
): boolean {
  const states = lensStates(db, { ticketId, prNumber, since });
  return lenses.every((l) => !lensNeedsRun(states.get(l)));
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
