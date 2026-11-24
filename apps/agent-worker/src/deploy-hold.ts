import type Database from 'better-sqlite3';
import type { AgentWorkerConfig } from './shared/config';
import { logger } from './shared/logger';
import { ensureRobotStateTable, takeDeployHold, releaseDeployHold, DEPLOY_HOLD_REASON } from './jobs/robot/state';
import { inFlightRunCount } from './jobs/maintenance/in-flight';

/**
 * Deploy hold logic for the agent-worker (PD-802, slice of the Watchtower cutover; D-105). The CLI
 * entry point is `deploy-drain.ts`; this module holds everything it and the worker's boot share.
 *
 * **Never import `deploy-drain.ts` from the worker.** esbuild inlines an imported module into
 * `dist/index.js`, where its `require.main === module` guard is true, so the drain CLI ran and
 * exited 0 on every worker boot: a crash loop under `restart: unless-stopped` (2026-11-21).
 *
 * A Watchtower pre-update lifecycle hook runs `node dist/deploy-drain.js` BEFORE it recreates the
 * agent-worker container. Recreating the container would kill any in-flight Robot run (the SIGTERM
 * drain of PD-784/D-104 only aborts it cleanly and pushes WIP; the run still ends), so this entrypoint:
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
 * update is **skipped and retried on the next poll**. It is the ONLY code that stops an update: any
 * other non-zero exit is just logged as an error and the recreate goes ahead anyway (Watchtower's
 * lifecycle-hooks docs, "Execution failure"). Exit 0 lets the recreate proceed. Hence the drain
 * fails closed — see {@link runDeployDrainFailClosed} (PD-816; amends D-105's exit-code claim).
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
 * The drain as the CLI runs it: open the DB, run {@link runDeployDrain}, close — and **fail closed**.
 *
 * Any error (config load, DB open/lock, a throw inside the drain) returns `EX_TEMPFAIL`, never 1.
 * Watchtower only skips an update on 75; a crashing drain that exited 1 would let the recreate
 * proceed and kill whatever Robot run is in flight — the exact thing the hook exists to prevent
 * (PD-816). Skipping costs one poll interval; the next poll retries. A drain that is broken for
 * good therefore blocks worker auto-deploys (loudly, in the logs) rather than silently killing runs;
 * `robot-refresh` still deploys by hand.
 */
export function runDeployDrainFailClosed(
  open: () => { db: Database.Database; config: AgentWorkerConfig },
  now: number = Date.now(),
): number {
  let db: Database.Database | undefined;
  try {
    const opened = open();
    db = opened.db;
    return runDeployDrain(db, opened.config, now);
  } catch (err) {
    logger.error({ err }, 'deploy-drain: failed — skipping this update (exit 75, fail closed)');
    return EX_TEMPFAIL;
  } finally {
    try {
      db?.close();
    } catch (err) {
      logger.warn({ err }, 'deploy-drain: closing the DB failed (exit code unaffected)');
    }
  }
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
