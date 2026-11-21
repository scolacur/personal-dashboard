import type Database from 'better-sqlite3';
import { ROBOT_EVENT } from '@dashboard/shared';
import type { AgentWorkerConfig } from '../../shared/config';
import { logger } from '../../shared/logger';
import {
  classifyFault,
  decideFault,
  PROCESS_RESTART_SIGNATURE,
  type FaultClassification,
  type FaultPolicy,
} from './faults';
import { failedRunsForTicket, finishRun, orphanedRunningRuns, type OrphanRun } from './runs';
import { logMilestone } from './events';
import { notifyNeedsHuman } from './notify';
import { setAgentState } from './board';
import type { RunOwnership } from './ownership';

/**
 * In-process stall watchdog (D-055, C5/PD-346; reworked for ownership-based reclaim in PD-784/D-104)
 * — the Robot loop's DB-native stall detection (it replaced the retired `sortie-watchdog.yml`
 * Action).
 *
 * That old watchdog was an EXTERNAL, label-age-based Actions job because the retired runtime was a
 * closed process the board couldn't see into. The loop IS the process now, so detection is native —
 * but it keys off **ownership, not age** (D-104). Runs are concurrent and a run can outlive the
 * cycle that started it, so "any aged `running` row is an orphan" no longer holds. Each `running`
 * row whose ticket is still `working` is classified:
 *
 *  - **not owned by the live worker** → a *process-restart orphan*: the incarnation that opened it is
 *    gone (a deploy recreated the container). Reclaimed immediately, whatever its age — no 2h wait —
 *    through the SAME fault guardrail (C2) as an infra fault (D-104): always a transient re-queue,
 *    never counted against the ticket's budget, so a burst of deploys can't strand it.
 *  - **owned but hung** → the live worker is still executing it, but its session has made no progress
 *    past `stallThresholdMs` (measured from the LAST reported turn, not `started_at`). This is the
 *    age threshold's only remaining job: a genuine hang. Reclaimed through the ordinary stall path
 *    (a real transient fault that counts and promotes on repeat), its session aborted so the zombie
 *    is torn down.
 *  - **owned and progressing** → left alone, however old. A run still emitting turns is healthy.
 *
 * The old watchdog's queued-staleness sweep and label-rescue job are intentionally dropped: a
 * "dispatcher down" state cannot happen when the loop itself is the dispatcher, and there are no
 * state labels to lose or rescue now that the board DB is the state machine (D-055).
 */
export function reconcileStalledRuns(
  db: Database.Database,
  config: AgentWorkerConfig,
  policy: FaultPolicy,
  ownership: RunOwnership,
  now: number = Date.now(),
): number {
  let parked = 0;

  /** Close a run through the fault guardrail and re-queue or park its ticket. Shared by the orphan
   *  and hung-session paths so both take the identical C2 route. Returns 1 if the ticket parked. */
  const reclaim = (orphan: OrphanRun, cls: FaultClassification, ageMs: number): number => {
    const decision = decideFault(cls, failedRunsForTicket(db, orphan.ticketId), policy, null, now);
    finishRun(
      db,
      orphan.runId,
      { status: 'error', faultTier: decision.tier, faultSignature: decision.signature, faultReason: decision.reason },
      now,
    );
    if (decision.action === 'retry') {
      setAgentState(db, orphan.ticketId, 'queued', now);
      logMilestone(db, orphan.ticketId, ROBOT_EVENT.stalled, { reason: decision.reason, ageMs, state: 'queued' }, now);
      logger.warn({ ticketId: orphan.ticketId, signature: decision.signature }, 'robot: stalled run → re-queued (transient)');
      return 0;
    }
    // park (or the never-here 'pause'/'wait') — surface it and stop re-dispatching.
    setAgentState(db, orphan.ticketId, 'stuck', now);
    logMilestone(db, orphan.ticketId, ROBOT_EVENT.stalled, { reason: decision.reason, ageMs, state: 'stuck' }, now);
    notifyNeedsHuman(db, orphan.ticketId, 'Robot ticket stuck', decision.reason, now);
    logger.warn({ ticketId: orphan.ticketId, reason: decision.reason }, 'robot: stalled run → parked (stuck)');
    return 1;
  };

  for (const orphan of orphanedRunningRuns(db)) {
    if (!ownership.owns(orphan.runId)) {
      // The worker that opened this `running` row is gone — reclaim at once, as an infra fault that
      // re-queues and never burns budget (D-104).
      const ageMs = now - orphan.startedAt;
      const cls: FaultClassification = {
        tier: 'transient',
        signature: PROCESS_RESTART_SIGNATURE,
        reason: 'stalled: process restart orphan (started by a previous worker incarnation)',
      };
      parked += reclaim(orphan, cls, ageMs);
      continue;
    }

    // Owned: the live worker is executing it. Only a HUNG session (no progress past the threshold,
    // measured from the last turn) is reclaimed; a progressing one is left alone however old.
    const lastProgressAt = ownership.lastProgressAt(orphan.runId) ?? orphan.startedAt;
    const staleMs = now - lastProgressAt;
    if (staleMs <= config.robot.stallThresholdMs) continue;

    const ageMin = Math.round(staleMs / 60_000);
    // A genuine hang IS a ticket signal: classify through the normal path (a normalized signature)
    // so repeated hangs count and promote transient→deterministic, unlike the infra orphan above.
    const cls = classifyFault({ verifyOk: false, error: `stalled: run made no progress for ${ageMin}m` }, now);
    // Tear the zombie session down so it can't keep writing after we've re-queued the ticket.
    ownership.get(orphan.runId)?.abort.abort();
    ownership.end(orphan.runId);
    parked += reclaim(orphan, cls, staleMs);
  }
  return parked;
}
