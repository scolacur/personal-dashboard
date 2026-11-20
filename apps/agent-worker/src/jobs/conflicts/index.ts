import type Database from 'better-sqlite3';
import type { AgentWorkerConfig } from '../../shared/config';
import { logger } from '../../shared/logger';
import { ensureConflictAttemptsTable, runConflictPass } from './pass';

/**
 * Start the conflict resolver (PD-774, D-099). Off unless CONFLICT_RESOLVER_ENABLED, because it
 * pushes to PR branches. Never overlaps itself: one resolution runs a full `npm ci` + verify.
 */
export function startConflictJob(db: Database.Database, config: AgentWorkerConfig): void {
  ensureConflictAttemptsTable(db);
  if (!config.conflictResolver.enabled) {
    logger.info('conflicts: disabled (CONFLICT_RESOLVER_ENABLED unset) — conflicting PRs are not auto-resolved');
    return;
  }
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    void runConflictPass(db, config)
      .catch((err) => logger.error({ err }, 'conflicts: pass failed'))
      .finally(() => {
        running = false;
      });
  }, Math.min(config.conflictResolver.intervalMs, 60_000));
  logger.info({ intervalMs: config.conflictResolver.intervalMs }, 'conflict resolver ready');
}

export { runConflictPass } from './pass';
