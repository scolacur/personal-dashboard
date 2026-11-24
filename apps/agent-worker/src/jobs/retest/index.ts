import type Database from 'better-sqlite3';
import type { AgentWorkerConfig } from '../../shared/config';
import { logger } from '../../shared/logger';
import { ensureRetestAttemptsTable, runRetestPass } from './pass';

/**
 * Start the re-test job (PD-942): once main goes green, give each PR that failed `verify` on the
 * broken main one fresh CI run. On by default (RETEST_ENABLED=0 turns it off): it never pushes, it
 * only toggles draft → ready. Inert without ROBOT_GITHUB_TOKEN, since GITHUB_TOKEN-caused events
 * don't start workflows.
 */
export function startRetestJob(db: Database.Database, config: AgentWorkerConfig): void {
  ensureRetestAttemptsTable(db);
  if (!config.retest.enabled) {
    logger.info('retest: disabled (RETEST_ENABLED=0) — PRs that failed on a red main are not re-tested');
    return;
  }
  if (!config.robot.writeToken) {
    logger.info('retest: no ROBOT_GITHUB_TOKEN — PRs that failed on a red main are not re-tested');
    return;
  }
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    void runRetestPass(db, config)
      .catch((err) => logger.error({ err }, 'retest: pass failed'))
      .finally(() => {
        running = false;
      });
  }, Math.min(config.retest.intervalMs, 60_000));
  logger.info({ intervalMs: config.retest.intervalMs }, 're-test of red-main PRs ready');
}

export { runRetestPass } from './pass';
