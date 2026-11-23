import type Database from 'better-sqlite3';
import type { AgentWorkerConfig } from '../../shared/config';
import { logger } from '../../shared/logger';
import { ensureSzzTables, runSzzPass } from './pass';

/**
 * Start the SZZ job (PD-916): trace each fixed bug back to the PR that introduced it. Read-only and
 * model-free. Runs on boot and then hourly; a pass whose inputs (main's head, the set of fixed bugs)
 * have not moved returns at once. Never overlaps itself.
 */
export function startSzzJob(db: Database.Database, config: AgentWorkerConfig): void {
  ensureSzzTables(db);
  if (!config.szz.enabled) {
    logger.info('szz: disabled (SZZ_ENABLED=0) — bug introductions are not computed');
    return;
  }
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void runSzzPass(db, config)
      .catch((err) => logger.error({ err }, 'szz: pass failed'))
      .finally(() => {
        running = false;
      });
  };
  tick();
  setInterval(tick, config.szz.intervalMs);
  logger.info({ intervalMs: config.szz.intervalMs }, 'szz ready');
}

export { runSzzPass } from './pass';
