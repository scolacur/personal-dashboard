import type Database from 'better-sqlite3';
import { ROBOT_EVENT } from '@dashboard/shared';
import type { AgentWorkerConfig } from '../../shared/config';
import { logger } from '../../shared/logger';
import { classifyFault, decideFault, type FaultPolicy } from './faults';
import { failedRunsForTicket, finishRun, orphanedRunningRuns } from './runs';
import { logMilestone } from './events';
import { notifyNeedsHuman } from './notify';
import { setAgentState } from './board';

/**
 * In-process stall watchdog (D-055, C5/PD-346) — the Robot loop's DB-native stall detection (it
 * replaced the retired `sortie-watchdog.yml` Action).
 *
 * That old watchdog was an EXTERNAL, label-age-based Actions job because the retired runtime was a
 * closed process the board couldn't see into. The loop IS the process now, so stall detection is native: a run stuck
 * in `running` past the threshold whose ticket is still `working` is an orphan — the process died or
 * restarted mid-run, leaving a zombie run and a `working` ticket that `robotQueueCandidates` never
 * re-picks (only NULL/`queued` are dispatchable). This sweep closes the run and routes it through the
 * SAME fault guardrail (C2) a normal failure takes: a first stall is transient (re-queue for a fresh
 * attempt); a repeated stall promotes to deterministic and parks `stuck` with a Notification-Center
 * entry (replacing the watchdog's @-mention).
 *
 * The old watchdog's queued-staleness sweep and label-rescue job are intentionally dropped: a
 * "dispatcher down / not dispatching" state cannot happen when the loop itself is the dispatcher, and there are no state
 * labels to lose or rescue now that the board DB is the state machine (D-055).
 */
export function reconcileStalledRuns(
  db: Database.Database,
  config: AgentWorkerConfig,
  policy: FaultPolicy,
  now: number = Date.now(),
): number {
  const cutoff = now - config.robot.stallThresholdMs;
  let parked = 0;

  for (const orphan of orphanedRunningRuns(db, cutoff)) {
    const ageMs = now - orphan.startedAt;
    const ageMin = Math.round(ageMs / 60_000);
    // Numbers get normalized to a stable signature by the fault engine, so repeated stalls share one
    // signature and promote transient→deterministic (park) at `promoteAfter`.
    const errText = `stalled: run made no progress for ${ageMin}m (process restart orphan)`;
    const cls = classifyFault({ verifyOk: false, error: errText });
    const decision = decideFault(cls, failedRunsForTicket(db, orphan.ticketId), policy);

    finishRun(
      db,
      orphan.runId,
      { status: 'error', faultTier: decision.tier, faultSignature: decision.signature, faultReason: decision.reason },
      now,
    );

    if (decision.action === 'retry') {
      setAgentState(db, orphan.ticketId, 'queued', now);
      logMilestone(db, orphan.ticketId, ROBOT_EVENT.stalled, { reason: decision.reason, ageMs, state: 'queued' }, now);
      logger.warn({ ticketId: orphan.ticketId, ageMin }, 'robot: stalled run → re-queued (transient)');
    } else {
      // park (or the never-here 'pause') — surface it and stop re-dispatching.
      setAgentState(db, orphan.ticketId, 'stuck', now);
      logMilestone(db, orphan.ticketId, ROBOT_EVENT.stalled, { reason: decision.reason, ageMs, state: 'stuck' }, now);
      notifyNeedsHuman(db, orphan.ticketId, 'Robot ticket stuck', decision.reason, now);
      logger.warn({ ticketId: orphan.ticketId, reason: decision.reason }, 'robot: stalled run → parked (stuck)');
      parked++;
    }
  }
  return parked;
}
