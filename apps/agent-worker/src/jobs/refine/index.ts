import type Database from 'better-sqlite3';
import type { AgentWorkerConfig } from '../../shared/config';
import { logger } from '../../shared/logger';
import { processPendingRefines, RefineBackoff, WarmSessions } from './refine';
import { ensureRobotStateTable } from '../robot/state';

/**
 * Start the Refine job (D-044, PD-267/PD-268). Polls the shared DB for pending Refine
 * turns and answers them. Extracted from the entrypoint by PD-282 so the agent-worker
 * can host multiple jobs (audit lands in PD-283/D-045) — behavior is unchanged.
 *
 * Warm sessions persist across poll cycles (survive web redeploys — this is a separate
 * process), so active back-and-forth reuses a resident session; idle ones are swept.
 */
export function startRefineJob(db: Database.Database, config: AgentWorkerConfig): void {
  // PD-618: Refine reads the shared session-limit hold, so the table has to exist — and it was
  // created only by the Robot job. With `ROBOT_DISPATCH_ENABLED` off, Refine would have thrown
  // `no such table: robot_state` on every cycle. Idempotent `CREATE TABLE IF NOT EXISTS`.
  ensureRobotStateTable(db);
  const sessions = new WarmSessions();
  // Long-lived so retry spacing survives poll cycles (PD-618) — a per-cycle instance would forget
  // every failure and reproduce the 5-second retry loop it exists to prevent.
  const backoff = new RefineBackoff();

  // Refine poll loop. A refine turn can run for many seconds, so an in-flight guard skips
  // overlapping ticks rather than double-processing a ticket.
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    void processPendingRefines(db, config, { sessions, backoff })
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
