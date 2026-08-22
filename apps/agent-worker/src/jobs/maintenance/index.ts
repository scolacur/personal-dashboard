import type Database from 'better-sqlite3';
import { HOLD_CADENCE_MS, HOLD_WINDOW_MS } from '@dashboard/shared';
import type { AgentWorkerConfig } from '../../shared/config';
import { logger } from '../../shared/logger';
import { CONSOLIDATION_JOB_NAME, consolidationJobRunner, inFlightRunCount } from '../number-decisions';
import { tick, type CoordinatorConfig, type CoordinatorDeps, type MaintenanceJobRunner } from './coordinator';
import { holdsTablesReady } from './holds-db';

/**
 * Start the maintenance-hold coordinator (PD-498).
 *
 * Inert unless `DECISION_CONSOLIDATION_JOB_ENABLED=1`, the same shape as the Robot loop and the
 * Evaluator: this opens a window in which dispatch is held and a job rewrites the decision log
 * repo-wide and admin-merges its own PR. That should not begin because an image was deployed.
 *
 * The flag still carries the consolidation job's name because that is the only maintenance job
 * today and it is what the flag actually gates. A second job would want its own.
 */
export function startMaintenanceCoordinator(db: Database.Database, config: AgentWorkerConfig): void {
  if (!config.numbering.enabled) {
    logger.info('maintenance: disabled (DECISION_CONSOLIDATION_JOB_ENABLED is not set) — no holds will be taken');
    return;
  }

  const jobs = new Map<string, MaintenanceJobRunner>([[CONSOLIDATION_JOB_NAME, consolidationJobRunner(config)]]);

  const coordinatorConfig: CoordinatorConfig = {
    cadenceMs: HOLD_CADENCE_MS,
    windowMs: HOLD_WINDOW_MS,
    // Same bound a stalled run gets — the ~2h worst case D-078 refers to.
    drainTimeoutMs: config.robot.stallThresholdMs,
  };
  const deps: CoordinatorDeps = {
    inFlightRuns: () => inFlightRunCount(db),
    now: () => Date.now(),
    jobs,
  };

  let running = false;
  setInterval(() => {
    if (running) return; // a tick can outlast its interval — the consolidation job polls CI
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
  }, config.numbering.pollMs);

  logger.info(
    { pollMs: config.numbering.pollMs, cadenceMs: HOLD_CADENCE_MS, windowMs: HOLD_WINDOW_MS },
    'maintenance coordinator ready',
  );
}
