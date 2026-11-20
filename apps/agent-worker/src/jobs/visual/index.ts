import type Database from 'better-sqlite3';
import type { AgentWorkerConfig } from '../../shared/config';
import { logger } from '../../shared/logger';
import { ensureRobotStateTable } from '../robot/state';
import { runVisualPass } from './pass';
import { ensureVisualCapturesTable, recordCaptureHeartbeat } from './status';

/**
 * Start the visual-capture job (PD-773). Captures only when VISUAL_CAPTURE_ENABLED; never overlaps
 * itself. It ticks either way, because every tick writes the capture heartbeat (PD-794): the dashboard
 * can't read the worker's env, so this is how it tells "capture is off" from "worker not reporting".
 */
export function startVisualJob(db: Database.Database, config: AgentWorkerConfig): void {
  ensureVisualCapturesTable(db);
  ensureRobotStateTable(db);
  recordCaptureHeartbeat(db, config, Date.now());
  if (!config.visual.enabled) {
    logger.info('visual: disabled (VISUAL_CAPTURE_ENABLED unset) — Robot UI PRs get no screenshots, and the visual gate skips itself');
  }
  let running = false;
  setInterval(() => {
    try {
      recordCaptureHeartbeat(db, config, Date.now());
    } catch (err) {
      logger.warn({ err }, 'visual: heartbeat write failed');
    }
    if (!config.visual.enabled || running) return;
    running = true;
    void runVisualPass(db, config)
      .catch((err) => logger.error({ err }, 'visual: pass failed'))
      .finally(() => {
        running = false;
      });
  }, Math.min(config.visual.intervalMs, 60_000));
  if (config.visual.enabled) logger.info({ intervalMs: config.visual.intervalMs }, 'visual capture job ready');
}
