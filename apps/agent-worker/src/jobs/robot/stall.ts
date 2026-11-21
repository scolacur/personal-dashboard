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
import { ABORT_HUNG, type RunOwnership } from './ownership';
import { recordUncleanRestart } from './restart-breaker';

/**
 * In-process stall watchdog (D-055, C5/PD-346; reworked for ownership-based reclaim in PD-784/D-104)
 * — the Robot loop's DB-native stall detection (it replaced the retired `sortie-watchdog.yml`
 * Action).
 *
 * It keys off **ownership, not age** (D-104). Each `running` row whose ticket is still `working` is
 * classified:
 *
 *  - **not owned by the live worker** → a *process-restart orphan*: the incarnation that opened it
 *    died without a graceful stop (a graceful stop closes its runs as `interrupted` first). Reclaimed
 *    immediately, whatever its age — no 2h wait — outside the ordinary retry budget but against the
 *    per-ticket orphan cap (faults.ts). An incarnation that finds any orphans also records one
 *    unclean restart for the worker-wide restart breaker (restart-breaker.ts).
 *  - **owned but hung** → the live worker is still executing it, but its session has made no progress
 *    past `stallThresholdMs` (measured from the LAST reported turn, not `started_at`). Reclaimed as
 *    an ordinary transient fault (counts, promotes on repeat); its session is aborted with reason
 *    `hung` so the loop knows the run is already closed and does not close it again.
 *  - **owned and progressing** → left alone, however old.
 *
 * **Today the owned branches never fire.** With `ROBOT_CONCURRENCY = 1` and every session awaited
 * inside the cycle, this sweep (which runs at cycle start) always sees an empty ownership registry,
 * so every row it finds is an orphan — and a genuinely hung session blocks the cycle, this sweep
 * included, so nothing detects it. The owned branches are kept, and tested, because they become live
 * the moment a run can outlive the cycle that started it (concurrency > 1 with non-blocking
 * dispatch); at that point "unowned ⇒ orphan" is still exactly right, while age alone would reclaim a
 * live run.
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

  let orphans = 0;
  for (const orphan of orphanedRunningRuns(db)) {
    if (!ownership.owns(orphan.runId)) {
      // The worker that opened this `running` row died uncleanly — reclaim at once, outside the
      // ordinary budget but against the per-ticket orphan cap (D-104).
      const ageMs = now - orphan.startedAt;
      const cls: FaultClassification = {
        tier: 'transient',
        signature: PROCESS_RESTART_SIGNATURE,
        reason: 'stalled: process restart orphan (started by a worker incarnation that died uncleanly)',
      };
      parked += reclaim(orphan, cls, ageMs);
      orphans++;
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
    // Tear the zombie session down so it can't keep writing after we've re-queued the ticket. The
    // `hung` reason tells the loop this run is already closed here, so it must not close it again.
    ownership.get(orphan.runId)?.abort.abort(ABORT_HUNG);
    ownership.end(orphan.runId);
    parked += reclaim(orphan, cls, staleMs);
  }

  // One unclean restart per incarnation, however many runs it orphaned (D-104).
  if (orphans > 0) {
    recordUncleanRestart(
      db,
      ownership.processStartedAt,
      { count: config.robot.restartBreakerCount, windowMs: config.robot.restartBreakerWindowMs },
      now,
    );
  }
  return parked;
}
