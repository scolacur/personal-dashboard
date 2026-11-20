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
  // PD-767: every `revise` since the last dispatch — one per reviewer — merged into one brief, so a
  // PR both the code and the security reviewer sent back is reworked once with both sets of findings.
  let rows: Row[];
  try {
    rows = db
      .prepare(
        `SELECT verdict, findings, summary, started_at
           FROM evaluator_runs
          WHERE ticket_id = ? AND verdict = 'revise' AND started_at > ?
          ORDER BY started_at ASC, id ASC`,
      )
      .all(ticketId, lastDispatch) as Row[];
  } catch {
    // `evaluator_runs` does not exist — the Evaluator has never been started in this deployment.
    // The Robot loop must not crash because an OPTIONAL reviewer was never initialised: this is
    // read on the dispatch path, so throwing here would take down dispatch itself. Absent
    // Evaluator ⇒ no brief, which is exactly right.
    return null;
  }
  // PD-773: Steve's visual rejection since the last dispatch rides along in the same brief.
  const visual = visualRejectionSince(db, ticketId, lastDispatch);
  // A revise at or before the last dispatch was already consumed by that dispatch (the query bound).
  if (rows.length === 0) return visual;

  const report: EvaluatorReport = {
    verdict: 'revise',
    findings: rows.flatMap((r) => parseFindings(r.findings)),
    summary: rows.map((r) => r.summary ?? '').filter(Boolean).join(' '),
  };
  if (report.findings.length === 0) return visual;
  return visual ? `${reworkBrief(report)}\n\n${visual}` : reworkBrief(report);
}

/** Steve's newest visual "request changes" after `since`, as a brief section; null when none. */
export function visualRejectionSince(db: Database.Database, ticketId: number, since: number): string | null {
  const row = db
    .prepare(
      `SELECT detail FROM agent_ticket_events
        WHERE ticket_id = ? AND type = 'robot_visual_reviewed' AND created_at > ?
        ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(ticketId, since) as { detail: string | null } | undefined;
  if (!row) return null;
  let d: { approved?: boolean; note?: string } = {};
  try {
    d = JSON.parse(row.detail ?? '{}');
  } catch {
    return null;
  }
  if (d.approved !== false) return null;
  return [
    "## Steve's visual check: changes requested",
    '',
    d.note?.trim() || '(no note) He looked at the screenshots of your PR and asked for changes; ask him what if it is unclear.',
    '',
    'Fix this on the same branch. The PR is photographed again and waits for his visual check again.',
  ].join('\n');
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
