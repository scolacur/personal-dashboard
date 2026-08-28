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
 * counting it would skip a day of work.
 *
 * **No jobs means nothing to schedule** (PD-560). Since the allocation counter retired decision
 * consolidation the job map is empty, and a scheduled hold would drain dispatch, run nothing and
 * release — on a timer, forever. Manual holds are unaffected: a human asking for a window is asking
 * for the window itself, and `tick` services those regardless.
 */
export function ensureScheduledHold(
  db: Database.Database,
  config: CoordinatorConfig,
  now: number,
  jobCount = 1,
): void {
  if (jobCount === 0) return;
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
      if (!windowHasRoom(open.startedAt, now, config.windowMs)) {
        // Refused rather than started late: the window is what bounds the hold, and a job started
        // after it lapsed would hold dispatch past the deadline the button itself advertises.
        logger.warn(
          { holdId: open.id, jobName: request.jobName },
          'maintenance: window spent before the requested job could start — not starting it',
        );
      } else {
        await runJob(db, open.id, request.jobName, deps);
        return;
      }
    }
    // Window elapsed with nothing left to do: close it and give dispatch back.
    if (open.startedAt !== null && now - open.startedAt >= config.windowMs) {
      endHold(db, open.id, 'completed', null, now);
      releaseMaintenanceHold(db, now);
      logger.info({ holdId: open.id }, 'maintenance: hold window closed — dispatch released');
    }
    return;
  }

  ensureScheduledHold(db, config, now, deps.jobs.size);

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

  const skipped: string[] = [];
  for (const jobName of deps.jobs.keys()) {
    // PD-546: budget the STARTS. Checked before each job rather than once up front, because the
    // whole point is that the jobs ahead of this one have already spent some of the window.
    if (!windowHasRoom(queued.startedAt ?? now, deps.now(), config.windowMs)) {
      skipped.push(jobName);
      continue;
    }
    await runJob(db, queued.id, jobName, deps);
  }
  if (skipped.length > 0) {
    // Not an error. A skipped job runs in the next hold; the cadence is what makes that safe.
    logger.warn({ holdId: queued.id, skipped }, 'maintenance: window spent — remaining jobs deferred to the next hold');
  }

  // A scheduled hold has done what it came for; close it immediately rather than sitting on
  // dispatch for the rest of the window. A MANUAL hold stays open — the human asked for a window,
  // and "Run now" is only enabled while one is open — UNLESS the jobs overran it, in which case
  // the window it was asking for no longer exists and sitting on dispatch would be the bug.
  const closingNote = skipped.length > 0 ? `${skipped.length} job(s) deferred — window spent` : null;
  if (queued.trigger === 'scheduled' || !windowHasRoom(queued.startedAt ?? now, deps.now(), config.windowMs)) {
    endHold(db, queued.id, 'completed', closingNote, deps.now());
    releaseMaintenanceHold(db, deps.now());
    logger.info({ holdId: queued.id, trigger: queued.trigger }, 'maintenance: hold complete — dispatch released');
  }
}

/**
 * Is there any of the window left to start a job in? (PD-546)
 *
 * **Starts are budgeted; running jobs are never killed.** The alternative — cancelling a job that
 * has run past the deadline — means a consolidation cycle can be interrupted between rewriting the
 * citations and pushing the branch, which is the one state this machinery must never be left in.
 * So the guarantee is the weaker, honest one: nothing NEW starts once the window is spent, and the
 * hold can overrun by at most the length of the single job already running.
 *
 * That bound is only as good as the jobs are short. It is the reason a job that could plausibly
 * exceed the window belongs in its own hold, not appended to this list.
 */
export function windowHasRoom(startedAt: number | null, now: number, windowMs: number): boolean {
  if (startedAt === null) return true;
  return now - startedAt < windowMs;
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
