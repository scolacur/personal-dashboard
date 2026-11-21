import type Database from 'better-sqlite3';
import { loadConfig, type AgentWorkerConfig } from './shared/config';
import { openDb } from './shared/db';
import { logger } from './shared/logger';
import { ensureRobotStateTable, takeDeployHold, releaseDeployHold, DEPLOY_HOLD_REASON } from './jobs/robot/state';
import { inFlightRunCount } from './jobs/maintenance/in-flight';

/**
 * Deploy drain for the agent-worker (PD-802, slice of the Watchtower cutover; D-105).
 *
 * A Watchtower pre-update lifecycle hook runs `node dist/deploy-drain.js` BEFORE it recreates the
 * agent-worker container. Recreating the container would kill any in-flight Robot run (the worker
 * has no SIGTERM drain), so this entrypoint:
 *
 *   1. takes a **deploy hold** (its own `robot_state` slot, D-105) so no NEW run dispatches during
 *      the swap — bounded by `stallThresholdMs` so a drain that dies mid-recreate cannot wedge
 *      dispatch shut forever; and
 *   2. reports whether a run is still in flight, via the process exit code the hook reads.
 *
 * The matching release happens on the NEW container's boot (see {@link releaseDeployHoldOnStartup}),
 * so dispatch resumes once the recreate completes. Everything here is host-independent and unit
 * tested; the compose label / `WATCHTOWER_LIFECYCLE_HOOKS` / Watchtower service are the sibling
 * wiring ticket.
 */

/**
 * EX_TEMPFAIL from `sysexits.h`. Watchtower's pre-update lifecycle hook treats a 75 specially: the
 * update is **cancelled and retried on the next poll**, without being logged as an error the way any
 * other non-zero code would be. Exit 0 lets the recreate proceed.
 */
export const EX_TEMPFAIL = 75;

/**
 * Take the deploy hold and decide whether the recreate may proceed.
 *   - in-flight > 0 → return `EX_TEMPFAIL` (75) so Watchtower defers the recreate and the next poll
 *     retries, by which time the run may have finished and the hold keeps new ones from starting;
 *   - in-flight = 0 → return 0 so the recreate proceeds.
 *
 * The hold is taken in BOTH cases: once the hook starts draining, nothing new should dispatch even
 * on the retry path. `inFlightRunCount` only counts a `running` run whose ticket is still `working`,
 * so a stale run row can never block a deploy forever.
 */
export function runDeployDrain(db: Database.Database, config: AgentWorkerConfig, now: number = Date.now()): number {
  ensureRobotStateTable(db);
  takeDeployHold(db, now + config.robot.stallThresholdMs, DEPLOY_HOLD_REASON, now);
  const inFlight = inFlightRunCount(db);
  if (inFlight > 0) {
    logger.warn({ inFlight }, 'deploy-drain: run(s) still in flight — deferring the recreate (exit 75)');
    return EX_TEMPFAIL;
  }
  logger.info('deploy-drain: no runs in flight — recreate may proceed (exit 0)');
  return 0;
}

/**
 * Release a leftover deploy hold when the (new) worker process boots, so dispatch resumes after a
 * recreate. Clears ONLY the deploy slot: a human's manual maintenance window has its own slot and is
 * left untouched (D-105 — the one-owner-per-slot rule). Idempotent and safe to call when no hold is
 * set.
 */
export function releaseDeployHoldOnStartup(db: Database.Database, now: number = Date.now()): void {
  ensureRobotStateTable(db);
  releaseDeployHold(db, now);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDb(config);
  let code = 0;
  try {
    code = runDeployDrain(db, config);
  } finally {
    db.close();
  }
  process.exit(code);
}

if (require.main === module) {
  main().catch((err) => {
    logger.error({ err }, 'deploy-drain failed');
    process.exit(1);
  });
}
