import type Database from 'better-sqlite3';
import { HOLD_CADENCE_MS, HOLD_WINDOW_MS } from '@dashboard/shared';
import { logger } from '../../shared/logger';
import { releaseMaintenanceHold, takeMaintenanceHold } from '../robot/state';
import {
  activeHold,
  attachRunToHold,
  endHold,
  lastHoldStartedAt,
  nextQueuedHold,
  requestHold,
  startHold,
} from './holds-db';
import { claimMaintenanceJobRun } from './job-requests-db';

/**
 * The maintenance-hold coordinator (PD-498, extends D-078).
 *
 * **The hold is the scheduled thing.** D-078 shipped decision consolidation as a self-scheduling
 * job that took a hold internally; that inverts here. The coordinator owns the window — coming due
 * on a cadence, draining Robot runs, holding dispatch, releasing safely — and maintenance jobs run
 * *inside* it. A second maintenance job then inherits the drain, the bound and the log rather than
 * re-deriving them, which is the whole reason to generalise.
 *
 * It is also the only writer of hold state transitions. The web process can insert a `queued` row
 * (the Dev Ops button) and nothing else, because only this process can tell whether runs have
 * drained.
 */

/** A job a hold runs. Returns the `job_runs.id` it recorded, so the hold log can link to it. */
export type MaintenanceJobRunner = (db: Database.Database, holdId: number) => Promise<number | null>;

export interface CoordinatorDeps {
  inFlightRuns: () => number;
  now: () => number;
  /** Keyed by `job_runs.job_name`. Run in insertion order when a hold opens. */
  jobs: Map<string, MaintenanceJobRunner>;
}

export interface CoordinatorConfig {
  cadenceMs: number;
  windowMs: number;
  /** How long to keep waiting for runs to drain before abandoning the hold. */
  drainTimeoutMs: number;
}

export const DEFAULT_COORDINATOR_CONFIG: CoordinatorConfig = {
  cadenceMs: HOLD_CADENCE_MS,
  windowMs: HOLD_WINDOW_MS,
  drainTimeoutMs: 2 * 60 * 60_000,
};

/**
 * Queue a hold if the daily cadence has come due and nothing is already pending.
 *
 * Cadence is measured from the last hold that actually **started**, not from the last one
 * requested: a hold that sat queued for hours because Robots were busy has not done its rounds, and
 * counting it would skip a day of consolidation.
 */
export function ensureScheduledHold(db: Database.Database, config: CoordinatorConfig, now: number): void {
  if (activeHold(db) || nextQueuedHold(db)) return;
  const last = lastHoldStartedAt(db);
  if (last !== null && now - last < config.cadenceMs) return;
  const hold = requestHold(db, 'scheduled', now);
  logger.info({ holdId: hold.id }, 'maintenance: daily hold came due — queued');
}

/**
 * Advance the hold state machine by one tick. Called on the coordinator's poll interval.
 *
 * Deliberately a single step per tick rather than a loop that owns the whole window: the window is
 * up to 30 minutes and a human may press "Run now" at any point in it, so the coordinator has to
 * keep coming back to look rather than deciding everything up front.
 */
export async function tick(db: Database.Database, config: CoordinatorConfig, deps: CoordinatorDeps): Promise<void> {
  const now = deps.now();
  const open = activeHold(db);

  if (open) {
    // An on-demand "Run now" request takes priority — it is a human waiting on a button.
    const request = claimMaintenanceJobRun(db, open.id, now);
    if (request) {
      await runJob(db, open.id, request.jobName, deps);
      return;
    }
    // Window elapsed with nothing left to do: close it and give dispatch back.
    if (open.startedAt !== null && now - open.startedAt >= config.windowMs) {
      endHold(db, open.id, 'completed', null, now);
      releaseMaintenanceHold(db, now);
      logger.info({ holdId: open.id }, 'maintenance: hold window closed — dispatch released');
    }
    return;
  }

  ensureScheduledHold(db, config, now);

  const queued = nextQueuedHold(db);
  if (!queued) return;

  // Hold dispatch FIRST, then wait for the runs already going to finish. Taking the hold before
  // draining is what stops the queue refilling behind us — otherwise the drain is a treadmill.
  takeMaintenanceHold(db, now + config.drainTimeoutMs, `maintenance hold #${queued.id}`, now);

  const inFlight = deps.inFlightRuns();
  if (inFlight > 0) {
    if (now - queued.requestedAt >= config.drainTimeoutMs) {
      endHold(db, queued.id, 'abandoned', `${inFlight} run(s) never drained`, now);
      releaseMaintenanceHold(db, now);
      logger.warn({ holdId: queued.id, inFlight }, 'maintenance: drain timed out — hold abandoned');
    } else {
      logger.info({ holdId: queued.id, inFlight }, 'maintenance: waiting for runs to drain');
    }
    return; // still queued; try again next tick
  }

  startHold(db, queued.id, now);
  logger.info({ holdId: queued.id, trigger: queued.trigger }, 'maintenance: hold active — dispatch held');

  for (const jobName of deps.jobs.keys()) {
    await runJob(db, queued.id, jobName, deps);
  }

  // A scheduled hold has done what it came for; close it immediately rather than sitting on
  // dispatch for the rest of the window. A MANUAL hold stays open — the human asked for a window,
  // and "Run now" is only enabled while one is open.
  if (queued.trigger === 'scheduled') {
    endHold(db, queued.id, 'completed', null, deps.now());
    releaseMaintenanceHold(db, deps.now());
    logger.info({ holdId: queued.id }, 'maintenance: scheduled hold complete — dispatch released');
  }
}

/** Run one job inside a hold and attach whatever run it recorded to the hold's log. */
async function runJob(db: Database.Database, holdId: number, jobName: string, deps: CoordinatorDeps): Promise<void> {
  const runner = deps.jobs.get(jobName);
  if (!runner) {
    logger.warn({ holdId, jobName }, 'maintenance: no runner registered for job — skipping');
    return;
  }
  try {
    const jobRunId = await runner(db, holdId);
    if (jobRunId !== null) attachRunToHold(db, holdId, jobRunId);
  } catch (err) {
    // One job failing must not strand the hold: the window still has to close and dispatch still
    // has to come back. The job records its own failure in `job_runs`.
    logger.error({ err, holdId, jobName }, 'maintenance: job threw inside the hold');
  }
}
