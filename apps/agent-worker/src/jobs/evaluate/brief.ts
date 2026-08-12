import type Database from 'better-sqlite3';
import type { EvaluatorFinding, EvaluatorReport } from '@dashboard/shared';
import { reworkBrief } from './verdict';

/**
 * Handing an Evaluator `revise` to the next Robot run (PD-487, [[D-076]]).
 *
 * Mirrors `askHumanResume`'s contract exactly, including its consumption rule: a brief is pending
 * only while it is NEWER than the ticket's last dispatch. Without that boundary a satisfied rework
 * would be re-briefed with the complaint it already fixed on every subsequent run — the same stale
 * re-injection `askHumanResume` guards against, arrived at from the other direction.
 */

interface Row {
  verdict: string | null;
  findings: string | null;
  summary: string | null;
  started_at: number;
}

/**
 * The rework brief the next dispatch should inject, or null.
 *
 * Reads the Evaluator's OWN ledger rather than the event timeline: the event carries counts for
 * display, while `evaluator_runs` holds the findings themselves. Deriving the brief from the
 * findings each time means the wording the Robot receives always matches the recorded verdict —
 * there is no second copy of the text to drift.
 */
export function pendingEvaluatorBrief(db: Database.Database, ticketId: number): string | null {
  const lastDispatch = lastDispatchAt(db, ticketId);
  let row: Row | undefined;
  try {
    row = db
      .prepare(
        `SELECT verdict, findings, summary, started_at
           FROM evaluator_runs
          WHERE ticket_id = ? AND verdict = 'revise'
          ORDER BY started_at DESC, id DESC LIMIT 1`,
      )
      .get(ticketId) as Row | undefined;
  } catch {
    // `evaluator_runs` does not exist — the Evaluator has never been started in this deployment.
    // The Robot loop must not crash because an OPTIONAL reviewer was never initialised: this is
    // read on the dispatch path, so throwing here would take down dispatch itself. Absent
    // Evaluator ⇒ no brief, which is exactly right.
    return null;
  }
  if (!row) return null;
  // Already consumed by a dispatch that ran after it.
  if (row.started_at <= lastDispatch) return null;

  const report: EvaluatorReport = {
    verdict: 'revise',
    findings: parseFindings(row.findings),
    summary: row.summary ?? '',
  };
  if (report.findings.length === 0) return null;
  return reworkBrief(report);
}

/** Newest `robot_dispatched` timestamp, or 0. Mirrors `latestEventAt` without importing the robot
 *  job's event module into this one — the dependency should point evaluate → robot, not both ways. */
function lastDispatchAt(db: Database.Database, ticketId: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(created_at), 0) AS at FROM agent_ticket_events
        WHERE ticket_id = ? AND type = 'robot_dispatched'`,
    )
    .get(ticketId) as { at: number };
  return row.at;
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
