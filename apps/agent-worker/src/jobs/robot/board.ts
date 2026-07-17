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

/** `robot/<issue#>` when the ticket has a linked issue, else `robot/t<ticketId>` (branch-safe). */
export function branchFor(candidate: RobotCandidate): string {
  return candidate.issueNumber !== null ? `robot/${candidate.issueNumber}` : `robot/t${candidate.id}`;
}
