import type Database from 'better-sqlite3';
import type { AgentRun, RobotFaultTier, RobotRunStatus } from '@dashboard/shared';

/**
 * Read side for `agent_runs` — the Robot loop's per-attempt record (C3/PD-344 observability).
 * The agent-worker OWNS the write side (apps/agent-worker/src/jobs/robot/runs.ts) and creates the
 * table; the server only reads it from the same shared dashboard.db. Kept in its own module (like
 * audit-store.ts) so the store's ticket concerns stay separate. snake_case row → camelCase at the
 * boundary, per the store convention.
 */

interface AgentRunRow {
  id: number;
  ticket_id: number;
  issue_number: number | null;
  branch: string;
  status: string;
  session_id: string | null;
  pr_url: string | null;
  error: string | null;
  fault_tier: string | null;
  fault_signature: string | null;
  fault_reason: string | null;
  turns: number | null;
  tokens: number | null;
  started_at: number;
  finished_at: number | null;
}

function rowToRun(r: AgentRunRow): AgentRun {
  return {
    id: r.id,
    ticketId: r.ticket_id,
    issueNumber: r.issue_number,
    branch: r.branch,
    status: r.status as RobotRunStatus,
    sessionId: r.session_id,
    prUrl: r.pr_url,
    error: r.error,
    faultTier: r.fault_tier as RobotFaultTier | null,
    faultSignature: r.fault_signature,
    faultReason: r.fault_reason,
    turns: r.turns,
    tokens: r.tokens,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

/** A ticket's Robot runs, newest first. Empty array when the table doesn't exist yet (the worker
 *  has never run) — the loop is off by default, so this must not 500 the ticket-detail page. */
export function listRunsForTicket(db: Database.Database, ticketId: number): AgentRun[] {
  try {
    const rows = db
      .prepare('SELECT * FROM agent_runs WHERE ticket_id = ? ORDER BY started_at DESC, id DESC')
      .all(ticketId) as AgentRunRow[];
    return rows.map(rowToRun);
  } catch {
    return [];
  }
}
