import type Database from 'better-sqlite3';
import type { AgentWorkerConfig } from '../../shared/config';
import { logger } from '../../shared/logger';
import { processPendingRefines, WarmSessions } from './refine';

/**
 * Start the Refine job (D-044, PD-267/PD-268). Polls the shared DB for pending Refine
 * turns and answers them. Extracted from the entrypoint by PD-282 so the agent-worker
 * can host multiple jobs (audit lands in PD-283/D-045) — behavior is unchanged.
 *
 * Warm sessions persist across poll cycles (survive web redeploys — this is a separate
 * process), so active back-and-forth reuses a resident session; idle ones are swept.
 */
export function startRefineJob(db: Database.Database, config: AgentWorkerConfig): void {
  const sessions = new WarmSessions();

  // Refine poll loop. A grill turn can run for many seconds, so an in-flight guard skips
  // overlapping ticks rather than double-processing a ticket.
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    void processPendingRefines(db, config, { sessions })
      .catch((err) => logger.error({ err }, 'refine: poll cycle failed'))
      .finally(() => {
        running = false;
      });
  }, config.refineIntervalMs);

  // Idle-evict sweep — cheap; runs on the pull cadence.
  setInterval(() => sessions.sweep(), config.pullIntervalMs);

  logger.info(
    { refineIntervalMs: config.refineIntervalMs },
    'refine job ready — polling for Refine turns',
  );
}
