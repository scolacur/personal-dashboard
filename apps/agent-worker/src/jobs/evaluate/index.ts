import type Database from 'better-sqlite3';
import type { AgentWorkerConfig } from '../../shared/config';
import { logger } from '../../shared/logger';
import { ensureEvaluatorRunsTable } from './evaluator-runs';
import { runEvaluatePass } from './evaluate';

/**
 * Start the Evaluator job (PD-487, [[D-076]]).
 *
 * Its own poll loop and its own tables, like every other job here — which is the structural half of
 * "a budget that is not the run's". It shares only the checkout, proxy, config, and DB.
 *
 * The table is created even when the Evaluator is disabled, so turning it on later is purely a flag
 * flip rather than a flag flip plus a schema surprise on the first tick.
 */
export function startEvaluatorJob(db: Database.Database, config: AgentWorkerConfig): void {
  ensureEvaluatorRunsTable(db);

  if (!config.evaluator.enabled) {
    logger.info('evaluator: disabled (EVALUATOR_ENABLED unset) — no PRs will be reviewed');
    return;
  }

  let running = false;
  setInterval(() => {
    // An evaluation is a full agent pass over a diff; overlapping ticks would double-spend a budget
    // whose whole purpose is to be countable.
    if (running) return;
    running = true;
    void runEvaluatePass(db, config)
      .then((n) => {
        if (n > 0) logger.info({ evaluated: n }, 'evaluator: pass complete');
      })
      .catch((err) => logger.error({ err }, 'evaluator: poll cycle failed'))
      .finally(() => {
        running = false;
      });
  }, config.evaluator.intervalMs);

  logger.info(
    { intervalMs: config.evaluator.intervalMs, model: config.evaluator.model },
    'evaluator job ready — reviewing handed-off PRs',
  );
}

export { runEvaluatePass, evaluateOnePr } from './evaluate';
export { pendingEvaluatorBrief } from './brief';
