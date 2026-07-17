import type Database from 'better-sqlite3';
import type { AgentWorkerConfig } from '../../shared/config';
import { dbPathFor } from '../../shared/config';
import { logger } from '../../shared/logger';
import { checkDbLockedFromCoder } from './privilege';
import { ensureRunsTable } from './runs';
import { ensureRobotStateTable, dispatchPauseState } from './state';
import { processRobotQueue } from './robot';

/**
 * Start the Robot loop (D-055, PD-342): the in-house dispatcher. It
 * polls `queue` tickets in the shared board DB and drives each through a coding session in
 * an isolated worktree, handing off a PR. Inert unless `robot.dispatchEnabled` — the image ships
 * with the loop OFF so it stays dark until a deploy flips the switch (C6).
 *
 * An in-flight guard skips overlapping ticks (a coding session runs for minutes); dispatch is
 * serialized so a Robot never has two runs of the same ticket in flight.
 */
export function startRobotJob(db: Database.Database, config: AgentWorkerConfig): void {
  if (!config.robot.dispatchEnabled) {
    logger.info('robot loop DISABLED (ROBOT_DISPATCH_ENABLED unset) — no tickets will dispatch');
    return;
  }

  // Boot-time safety report: refuse to even arm the loop if the uid-split DB precondition fails.
  const lock = checkDbLockedFromCoder(dbPathFor(config), config);
  if (!lock.ok) {
    logger.error(
      { reason: lock.reason },
      'robot loop NOT started — dashboard.db is not locked away from the coding uid (fail closed)',
    );
    return;
  }

  ensureRunsTable(db);
  ensureRobotStateTable(db);

  // Surface a carried-over system-wide pause (C2): the loop arms but dispatches nothing until a
  // human resumes. Durable across restarts on purpose — auto-resuming would re-burn the board.
  const pause = dispatchPauseState(db);
  if (pause.paused) {
    logger.warn({ reason: pause.reason, since: pause.since }, 'robot loop ARMED but PAUSED (system-wide fault) — will not dispatch until resumed');
  }

  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    void processRobotQueue(db, config)
      .catch((err) => logger.error({ err }, 'robot: poll cycle failed'))
      .finally(() => {
        running = false;
      });
  }, config.robot.intervalMs);

  logger.info(
    {
      intervalMs: config.robot.intervalMs,
      concurrency: config.robot.concurrency,
      allowlist: config.robot.allowlist,
      uidSplit: config.robot.codingUid !== undefined,
    },
    'robot loop ready — polling queue (prove-on-one)',
  );
}
