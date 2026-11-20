import type Database from 'better-sqlite3';
import type { AgentWorkerConfig } from '../../shared/config';
import { logger } from '../../shared/logger';
import { ensureVisualCapturesTable, runVisualPass } from './pass';

/** Start the visual-capture job (PD-773). Off unless VISUAL_CAPTURE_ENABLED; never overlaps itself. */
export function startVisualJob(db: Database.Database, config: AgentWorkerConfig): void {
  ensureVisualCapturesTable(db);
  if (!config.visual.enabled) {
    logger.info('visual: disabled (VISUAL_CAPTURE_ENABLED unset) — Robot UI PRs get no screenshots');
    return;
  }
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    void runVisualPass(db, config)
      .catch((err) => logger.error({ err }, 'visual: pass failed'))
      .finally(() => {
        running = false;
      });
  }, Math.min(config.visual.intervalMs, 60_000));
  logger.info({ intervalMs: config.visual.intervalMs }, 'visual capture job ready');
}
