import type Database from 'better-sqlite3';
import type { AgentState } from '@dashboard/shared';
import type { RobotCandidate } from './select';

/**
 * Board-state writes for the Robot loop (D-055). Kept in a leaf module so the orchestrator
 * (robot.ts) and the C5 reconciliation sweeps (resume.ts / pr-state.ts / stall.ts) can all write
 * state without a circular import back through robot.ts. The LOOP is the sole `dashboard.db` writer;
 * the coding session (uid-split, D-039) never touches it.
 */

/** The loop's own board-state write. */
export function setAgentState(
  db: Database.Database,
  ticketId: number,
  state: AgentState,
  now: number = Date.now(),
): void {
  db.prepare('UPDATE agent_tickets SET agent_state = ?, updated_at = ? WHERE id = ?').run(state, now, ticketId);
}

/**
 * Terminal completion (C6/PD-347): the ticket's PR merged, so move it to the `completed` lane and
 * keep a green `done` pill. Writes `status` AND `agent_state` in one update — this is the DB-native
 * replacement for github-sync's old closed-issue→completed derivation, which is retired at cutover
 * (D-055: the board DB is authoritative, the PR is the completion signal). The loop is the sole
 * `dashboard.db` writer, so completion belongs here rather than in a label poll.
 */
export function completeTicket(
  db: Database.Database,
  ticketId: number,
  now: number = Date.now(),
): void {
  db.prepare(
    "UPDATE agent_tickets SET status = 'completed', agent_state = 'done', updated_at = ? WHERE id = ?",
  ).run(now, ticketId);
}

/** `robot/<issue#>` when the ticket has a linked issue, else `robot/t<ticketId>` (branch-safe). */
export function branchFor(candidate: RobotCandidate): string {
  return candidate.issueNumber !== null ? `robot/${candidate.issueNumber}` : `robot/t${candidate.id}`;
}
