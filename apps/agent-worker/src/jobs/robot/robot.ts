import type Database from 'better-sqlite3';
import type { AgentState } from '@dashboard/shared';
import type { AgentWorkerConfig } from '../../shared/config';
import { dbPathFor } from '../../shared/config';
import { logger } from '../../shared/logger';
import { robotQueueCandidates, selectDispatchable, type RobotCandidate } from './select';
import { checkDbLockedFromCoder } from './privilege';
import { ensureWorktree, removeWorktree, type Worktree } from './workspace';
import { runRobotSession, type RobotSessionResult } from './session';
import { ensureRunsTable, startRun, finishRun, runCountForTicket } from './runs';

/**
 * The Robot loop orchestration (D-055, PD-342): one poll cycle. Selects dispatchable
 * `robot_queue` tickets, and for each runs the full tracer-bullet path — worktree → coding
 * session → observe the filesystem hand-off → record the run → write the board state. The LOOP
 * is the sole `dashboard.db` writer; the coding session (uid-split) never touches it.
 *
 * C1 scope: skeleton with a HARD-CODED simple retry cap (below). The fault-tier taxonomy that
 * distinguishes transient/deterministic/system faults is C2; here we only stop obvious burn.
 */

/** Placeholder retry cap until C2 replaces it with the fault-tier policy. A ticket that has
 *  already accumulated this many runs is parked (`stuck`) instead of re-dispatched. */
export const SIMPLE_RETRY_CAP = 3;

/** The loop's own board-state write (loop is the sole writer — the coding session can't). */
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

export interface RobotDeps {
  /** Injectable so orchestration tests never open a real worktree. */
  ensureWorktree?: (config: AgentWorkerConfig, branch: string) => Promise<Worktree>;
  removeWorktree?: (config: AgentWorkerConfig, wt: Worktree) => Promise<void>;
  /** Injectable so tests never spawn a real coding session. */
  runSession?: (config: AgentWorkerConfig, c: RobotCandidate, wt: Worktree) => Promise<RobotSessionResult>;
  now?: () => number;
}

/**
 * Run one Robot poll cycle. Returns the number of tickets dispatched this cycle. Fails closed
 * (dispatches nothing) if the DB-perms precondition for the uid-split is not satisfied.
 */
export async function processRobotQueue(
  db: Database.Database,
  config: AgentWorkerConfig,
  deps: RobotDeps = {},
): Promise<number> {
  if (!config.robot.dispatchEnabled) return 0;

  // Fail-closed guard: never dispatch a Robot if dashboard.db isn't actually locked away from
  // the coding uid. Turns the uid-split from a documented assumption into a checked invariant.
  const lock = checkDbLockedFromCoder(dbPathFor(config), config);
  if (!lock.ok) {
    logger.error({ reason: lock.reason }, 'robot: DB-perms precondition failed — refusing to dispatch');
    return 0;
  }

  ensureRunsTable(db);
  const doEnsure = deps.ensureWorktree ?? ((c, b) => ensureWorktree(c, b));
  const doRemove = deps.removeWorktree ?? ((c, w) => removeWorktree(c, w));
  const doRun = deps.runSession ?? ((c, cand, w) => runRobotSession(c, cand, w));
  const now = deps.now ?? Date.now;

  // Sequential within a cycle; the job loop's in-flight guard prevents overlapping cycles.
  const selected = selectDispatchable(robotQueueCandidates(db), config.robot, 0);
  let dispatched = 0;

  for (const candidate of selected) {
    // Simple retry cap (C1 placeholder for C2). Park an over-retried ticket rather than burn.
    if (runCountForTicket(db, candidate.id) >= SIMPLE_RETRY_CAP) {
      logger.warn({ ticketId: candidate.id, cap: SIMPLE_RETRY_CAP }, 'robot: retry cap reached — parking (stuck)');
      setAgentState(db, candidate.id, 'stuck', now());
      continue;
    }

    const branch = branchFor(candidate);
    setAgentState(db, candidate.id, 'working', now());
    const runId = startRun(db, { ticketId: candidate.id, issueNumber: candidate.issueNumber, branch }, now());

    let worktree: Worktree | undefined;
    try {
      worktree = await doEnsure(config, branch);
      const result = await doRun(config, candidate, worktree);

      if (result.ok && result.verifyOk && result.prNumber !== undefined) {
        const prUrl = `https://github.com/${candidate.repo}/pull/${result.prNumber}`;
        finishRun(db, runId, { status: 'handed-off', sessionId: result.sessionId, prUrl }, now());
        setAgentState(db, candidate.id, 'in-review', now());
        dispatched++;
        logger.info({ ticketId: candidate.id, branch, prUrl }, 'robot: handed off PR');
      } else if (result.ok && !result.verifyOk) {
        // D-046 gate: the session ended without a green verify — leave WIP for retry, don't
        // publish a red PR. Re-queue so a later cycle retries (until the cap).
        finishRun(db, runId, { status: 'no-verify', sessionId: result.sessionId }, now());
        setAgentState(db, candidate.id, 'queued', now());
        logger.warn({ ticketId: candidate.id, branch }, 'robot: no verify-ok — left for retry');
      } else {
        finishRun(db, runId, { status: 'error', sessionId: result.sessionId, error: result.error }, now());
        setAgentState(db, candidate.id, 'queued', now());
        logger.warn({ ticketId: candidate.id, error: result.error?.slice(0, 200) }, 'robot: run errored — will retry');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      finishRun(db, runId, { status: 'error', error: msg }, now());
      setAgentState(db, candidate.id, 'queued', now());
      logger.error({ err, ticketId: candidate.id }, 'robot: dispatch failed');
    } finally {
      if (worktree) await doRemove(config, worktree);
    }
  }

  return dispatched;
}
