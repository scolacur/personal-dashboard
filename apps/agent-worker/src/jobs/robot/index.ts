import type Database from 'better-sqlite3';
import type { AgentWorkerConfig } from '../../shared/config';
import { dbPathFor } from '../../shared/config';
import { logger } from '../../shared/logger';
import { checkDbLockedFromCoder } from './privilege';
import { ensureRunsTable } from './runs';
import { ensureRobotStateTable, dispatchPauseState } from './state';
import { startRateLimitProbe } from './rate-limit';
import { processRobotQueue } from './robot';
import { createRunOwnership } from './ownership';
import { RobotShutdown } from './shutdown';

/**
 * A handle on the running Robot loop (PD-784/D-104), so the entrypoint can stop it gracefully on
 * SIGTERM: request the stop (which aborts in-flight sessions) and wait for the current cycle to
 * finish closing its runs before the process exits.
 */
export interface RobotLoopHandle {
  /** The graceful-stop coordinator. Always present, even when the loop is disabled/not armed (its
   *  `request()` is then a harmless no-op). */
  shutdown: RobotShutdown;
  /** Is a poll cycle currently executing? The entrypoint polls this to know the drain is done. */
  busy: () => boolean;
}

/**
 * Start the Robot loop (D-055, PD-342): the in-house dispatcher. It
 * polls `queue` tickets in the shared board DB and drives each through a coding session in
 * an isolated worktree, handing off a PR. Inert unless `robot.dispatchEnabled` — the image ships
 * with the loop OFF so it stays dark until a deploy flips the switch (C6).
 *
 * An in-flight guard skips overlapping ticks (a coding session runs for minutes); dispatch is
 * serialized so a Robot never has two runs of the same ticket in flight. The returned handle lets
 * the entrypoint drain in-flight runs on a stop signal (PD-784).
 */
export function startRobotJob(db: Database.Database, config: AgentWorkerConfig): RobotLoopHandle {
  // PD-784/D-104: the ownership registry is created ONCE here so it persists across cycles — that
  // is what lets the stall reconciler tell a run THIS process owns from a dead-incarnation orphan.
  const ownership = createRunOwnership();
  const shutdown = new RobotShutdown(ownership);
  let running = false;
  const handle: RobotLoopHandle = { shutdown, busy: () => running };
  // PD-248: the GitHub rate-limit probe is OBSERVABILITY, so it starts before every dispatch gate
  // below and runs even with the loop disarmed. That is precisely when headroom matters — you are
  // deciding whether it is safe to turn dispatch on, and a dashboard that only reports API health
  // once the loop is already running cannot inform that decision.
  ensureRobotStateTable(db);
  startRateLimitProbe(db, config);

  if (!config.robot.dispatchEnabled) {
    logger.info('robot loop DISABLED (ROBOT_DISPATCH_ENABLED unset) — no tickets will dispatch');
    return handle;
  }

  // Boot-time safety report: refuse to even arm the loop if the uid-split DB precondition fails.
  const lock = checkDbLockedFromCoder(dbPathFor(config), config);
  if (!lock.ok) {
    logger.error(
      { reason: lock.reason },
      'robot loop NOT started — dashboard.db is not locked away from the coding uid (fail closed)',
    );
    return handle;
  }

  ensureRunsTable(db);

  // Surface a carried-over system-wide pause (C2): the loop arms but dispatches nothing until a
  // human resumes. Durable across restarts on purpose — auto-resuming would re-burn the board.
  const pause = dispatchPauseState(db);
  if (pause.paused) {
    logger.warn({ reason: pause.reason, since: pause.since }, 'robot loop ARMED but PAUSED (system-wide fault) — will not dispatch until resumed');
  }

  setInterval(() => {
    if (running) return;
    // PD-784/D-104: once a graceful stop is under way, schedule no new cycle — the in-flight one
    // (if any) finishes closing its runs and then the entrypoint exits.
    if (shutdown.requested) return;
    running = true;
    void processRobotQueue(db, config, { ownership, shutdown })
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
  return handle;
}
