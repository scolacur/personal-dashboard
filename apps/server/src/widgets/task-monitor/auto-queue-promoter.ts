import type Database from 'better-sqlite3';
import type {
  AutoQueueCapacityId,
  AutoQueuePromotedItem,
  AutoQueuePromotionDetail,
  AutoQueueTickSummary,
} from '@dashboard/shared';
import { AUTO_QUEUE_EVENT, parseAutoQueueMode } from '@dashboard/shared';
import type { CronLogger, CronRegistry } from '../../cron';
import {
  createNotification,
  getTicket,
  queueGateContext,
  recordTicketEvent,
  setAutoQueueTickSummary,
  updateTicket,
} from './store';
import { queueGuardFailure } from './ticket-guards';
import {
  autoQueueLimits,
  backlogPromotionCandidates,
  buildAutoQueueCapacity,
  countDispatchableRobotTickets,
  countEpicInFlight,
  countRobotInReview,
  getTicketAutoQueueEligibility,
  robotConcurrency,
  workerUnhealthyReason,
} from './auto-queue';

/**
 * The server-side auto-queue promoter (D-103, PD-811).
 *
 * A Claude-free interval job that moves eligible Backlog members of ACTIVE Epics into the Queue, in
 * the same dispatch order the loop would next pick them (`backlogPromotionCandidates`). It is "a rule
 * executing Steve's Epic choice" (D-103 §1): it promotes only work whose `refined` flag a human set,
 * and it never touches `assignee`, `readyBypassed` or `refined`.
 *
 * It promotes through the SAME store path + guard the PATCH route uses (`queueGuardFailure` →
 * `updateTicket({status:'queue'})`), so D-091's `409 QUEUE_GATE` judges it like any other door into
 * the Queue — "the promoter adds no new way into the Queue" (D-103 §4). A guard refusal is LOGGED
 * (`auto_queue_refused`), never thrown.
 *
 * Worker/board health is READ, never computed: the circuit breaker's pause, dispatch pause, holds,
 * budget and heartbeat all surface through `workerUnhealthyReason` / the capacity snapshot (D-103 §5).
 *
 * Capacity is simulated IN MEMORY across a tick rather than re-read from the DB per candidate, so a
 * `dry-run` (which writes nothing) throttles exactly as `on` would: `queue-depth` and `epic-in-flight`
 * advance as the tick promotes, letting the audit trail say "would have queued X" honestly.
 */
export function runAutoQueueTick(db: Database.Database, now: number = Date.now()): AutoQueueTickSummary {
  const mode = parseAutoQueueMode(process.env.AUTO_QUEUE);
  const promotedItems: AutoQueuePromotedItem[] = [];
  let considered = 0;
  let stoppedBy: AutoQueueCapacityId | null = null;

  const summary = (workerHealthy: boolean, unhealthyReason: string | null): AutoQueueTickSummary => ({
    mode,
    ranAt: now,
    promoted: mode === 'on' ? promotedItems : [],
    wouldPromote: mode === 'dry-run' ? promotedItems : [],
    considered,
    stoppedBy,
    workerHealthy,
    ...(unhealthyReason ? { unhealthyReason } : {}),
  });

  // 1. Off does nothing but still records that it ran (so the checklist can show the mode).
  if (mode === 'off') {
    const s = summary(true, null);
    setAutoQueueTickSummary(db, s, now);
    return s;
  }

  // 2. An unhealthy worker stops the whole tick before any promotion (D-103 §4, §5).
  const unhealthyReason = workerUnhealthyReason(db, now);
  if (unhealthyReason !== null) {
    stoppedBy = 'worker-healthy';
    const s = summary(false, unhealthyReason);
    setAutoQueueTickSummary(db, s, now);
    return s;
  }

  const limits = autoQueueLimits();
  const queueDepthLimit = robotConcurrency(db) * limits.queueDepthFactor;
  const baseDepth = countDispatchableRobotTickets(db);
  const baseReview = countRobotInReview(db); // static across the tick — promoting doesn't add reviews
  let promoted = 0; // in-memory delta applied on top of baseDepth as the tick promotes
  const epicInFlight = new Map<number, number>(); // running in-flight count per Epic (base + delta)

  for (const candidate of backlogPromotionCandidates(db)) {
    const resp = getTicketAutoQueueEligibility(db, candidate.id, now);
    if (!resp || resp.isEpic || !resp.eligibility) continue;
    if (resp.eligibility.verdict !== 'eligible') continue;
    considered++;

    // 3. Board-wide hard stops — once hit, no further promotion is possible this tick.
    if (baseDepth + promoted >= queueDepthLimit) {
      stoppedBy = 'queue-depth';
      break;
    }
    if (baseReview >= limits.reviewWip) {
      stoppedBy = 'review-wip';
      break;
    }

    // 4. Per-Epic cap — skip this Epic's ticket but keep considering other Epics (one in flight per
    //    Epic holds across the whole tick, D-103 §4).
    const epicId = candidate.epicId;
    if (epicId === null) continue; // an eligible ticket always has an active Epic, but be defensive
    if (!epicInFlight.has(epicId)) epicInFlight.set(epicId, countEpicInFlight(db, epicId));
    const inFlightNow = epicInFlight.get(epicId)!;
    if (inFlightNow >= limits.epicInFlight) continue;

    // 5. Promote through the guard + store path. The capacity snapshot recorded is the state that
    //    justified THIS promotion (before the increment below).
    const capacity = buildAutoQueueCapacity({
      queueDepthCurrent: baseDepth + promoted,
      queueDepthLimit,
      reviewWipCurrent: baseReview,
      reviewWipLimit: limits.reviewWip,
      epicInFlightCurrent: inFlightNow,
      epicInFlightLimit: limits.epicInFlight,
      unhealthyReason: null,
    }).rows;

    const detail: AutoQueuePromotionDetail = {
      mode,
      epicId,
      criteria: resp.eligibility.criteria,
      capacity,
    };

    const existing = getTicket(db, candidate.id);
    if (!existing) continue; // vanished mid-tick
    const guardFail = queueGuardFailure(existing, { status: 'queue' }, queueGateContext(db));
    if (guardFail) {
      // "A refusal from the existing guard is logged, not bypassed" (D-103 §4). Never thrown.
      recordTicketEvent(db, candidate.id, AUTO_QUEUE_EVENT.refused, {
        code: guardFail.code,
        message: guardFail.message,
      });
      continue;
    }

    if (mode === 'on') {
      updateTicket(db, candidate.id, { status: 'queue' });
      // Written AFTER updateTicket's own `status_changed` so it wins the newest-event tiebreak that
      // drives the card's auto-queued badge (store `LATEST_REFINE_TYPE_SELECT`).
      recordTicketEvent(db, candidate.id, AUTO_QUEUE_EVENT.queued, detail);
    } else {
      // dry-run: everything except the status write (D-103 §4).
      recordTicketEvent(db, candidate.id, AUTO_QUEUE_EVENT.dryRun, detail);
    }

    promotedItems.push({ ticketId: candidate.id, displayId: candidate.displayId, epicId });
    promoted++;
    epicInFlight.set(epicId, inFlightNow + 1);
  }

  // 6. One digest per tick that actually promoted (D-103 §4) — not one per ticket, and not in
  //    dry-run (nothing was promoted).
  if (mode === 'on' && promotedItems.length > 0) {
    const n = promotedItems.length;
    createNotification(db, {
      kind: 'agent_auto_queued',
      ticketId: null,
      title: `Auto-queued ${n} ticket${n === 1 ? '' : 's'}`,
      body: promotedItems.map((p) => p.displayId).join(', '),
    });
  }

  const s = summary(true, null);
  setAutoQueueTickSummary(db, s, now);
  return s;
}

/** The promoter interval (default 60s). Follows the server's cron precedent (`audit-cron.ts`): a
 *  schedule string, env-overridable. `* * * * *` = every minute. */
export const AUTO_QUEUE_SCHEDULE = process.env.AUTO_QUEUE_SCHEDULE ?? '* * * * *';

/** Register the auto-queue promoter tick on the shared scheduler (D-103, PD-811). */
export function registerAutoQueuePromoter(cron: CronRegistry, log: CronLogger, db: Database.Database): void {
  cron.register('task-monitor:auto-queue', AUTO_QUEUE_SCHEDULE, () => {
    const s = runAutoQueueTick(db);
    if (s.mode === 'off') return; // silent while off
    const n = s.mode === 'on' ? s.promoted.length : s.wouldPromote.length;
    if (n > 0 || !s.workerHealthy || s.stoppedBy) {
      log.info(
        `auto-queue (${s.mode}): ${s.mode === 'on' ? 'promoted' : 'would promote'} ${n}` +
          (s.stoppedBy ? `, stopped by ${s.stoppedBy}` : '') +
          (s.workerHealthy ? '' : ` — worker unhealthy: ${s.unhealthyReason ?? 'unknown'}`),
      );
    }
  });
}
