import type Database from 'better-sqlite3';
import { HOLD_CADENCE_MS, HOLD_WINDOW_MS } from '@dashboard/shared';
import type { AgentWorkerConfig } from '../../shared/config';
import { logger } from '../../shared/logger';
import { tick, type CoordinatorConfig, type CoordinatorDeps, type MaintenanceJobRunner } from './coordinator';
import { holdsTablesReady } from './holds-db';
import { inFlightRunCount } from './in-flight';

/**
 * Start the maintenance-hold coordinator (D-082, D-085).
 *
 * ## It currently has no jobs, and that is deliberate (PD-560)
 *
 * Decision consolidation was its only subscriber, and the allocation counter retired it. The hold
 * itself stays: it is the general machinery for running anything that needs to touch shared files
 * with no Robot working, and it is the only *safe* way to do that. Rebuilding it later would mean
 * re-deriving draining, window-bounding and safe release on every exit path — three things that took
 * PD-498, D-081, D-082 and PD-546 to get right.
 *
 * So {@link MAINTENANCE_JOB_RUNNERS} is empty, and stays registered rather than deleted. Add a job
 * to it and everything below works unchanged.
 *
 * ## With no jobs, nothing is *scheduled*
 *
 * The coordinator still runs, because a **manual** hold requested from Dev Ops has to be serviced —
 * the web process can only insert the request row; draining and activating it happen here. But it
 * does not open holds on the cadence: a scheduled hold with no jobs would drain dispatch, do
 * nothing, and release, on a timer, forever. `ensureScheduledHold` is skipped when the job map is
 * empty (see `coordinator.ts`).
 */

/**
 * Jobs that run inside a hold, by name. Empty since PD-560.
 *
 * Order matters when there is more than one: the window budgets *starts* in this order, and jobs
 * that do not fit are deferred to the next hold (D-085).
 */
export const MAINTENANCE_JOB_RUNNERS = new Map<string, MaintenanceJobRunner>();

export function startMaintenanceCoordinator(db: Database.Database, config: AgentWorkerConfig): void {
  if (!config.maintenance.enabled) {
    logger.info('maintenance: disabled (MAINTENANCE_HOLD_ENABLED is not set) — no holds will be taken');
    return;
  }

  const coordinatorConfig: CoordinatorConfig = {
    cadenceMs: HOLD_CADENCE_MS,
    windowMs: HOLD_WINDOW_MS,
    // Same bound a stalled run gets — the ~2h worst case D-078 referred to.
    drainTimeoutMs: config.robot.stallThresholdMs,
  };
  const deps: CoordinatorDeps = {
    inFlightRuns: () => inFlightRunCount(db),
    now: () => Date.now(),
    jobs: MAINTENANCE_JOB_RUNNERS,
  };

  let running = false;
  setInterval(() => {
    if (running) return; // a tick can outlast its interval — a job may poll something slow
    running = true;
    void (async () => {
      // The web process owns the schema. If the worker booted first, wait rather than racing it
      // over who defines the columns.
      if (!holdsTablesReady(db)) return;
      await tick(db, coordinatorConfig, deps);
    })()
      .catch((err) => logger.error({ err }, 'maintenance: coordinator tick failed'))
      .finally(() => {
        running = false;
      });
  }, config.maintenance.pollMs);

  logger.info(
    { pollMs: config.maintenance.pollMs, cadenceMs: HOLD_CADENCE_MS, windowMs: HOLD_WINDOW_MS, jobs: MAINTENANCE_JOB_RUNNERS.size },
    'maintenance coordinator ready',
  );
}
