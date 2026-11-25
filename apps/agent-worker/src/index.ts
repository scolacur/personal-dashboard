import { loadConfig } from './shared/config';
import { installProxy } from './shared/proxy';
import { ensureCheckout, pullLatest } from './shared/checkout';
import { openDb } from './shared/db';
import { logger } from './shared/logger';
import { startRefineJob } from './jobs/refine';
import { startAuditJob } from './jobs/audit';
import { startRobotJob, type RobotLoopHandle } from './jobs/robot';
import { startEvaluatorJob } from './jobs/evaluate';
import { startConflictJob } from './jobs/conflicts';
import { startVisualJob } from './jobs/visual';
import { startSzzJob } from './jobs/szz';
import { startMaintenanceCoordinator } from './jobs/maintenance';
import { releaseDeployHoldOnStartup } from './deploy-hold';
import { startHeartbeat } from './heartbeat';
import { publishWorkerConfigBoot, startupConfig } from './shared/effective-config';

/**
 * agent-worker entrypoint (D-044 scaffold → D-045 multi-job host). Boots the long-lived
 * process: routes egress through the proxy, ensures the read-only grounding checkout and
 * keeps it fresh, opens the shared DB (failing fast if it isn't mounted), then dispatches
 * the registered jobs. Each job owns its own poll loop and tables; they share the
 * checkout, proxy, config, and DB set up here.
 *
 * Jobs: `refine` (interactive, D-044), `audit` (autonomous, weekly, D-045/PD-283), and
 * `robot` (the in-house dispatcher, D-055/PD-342 — inert unless ROBOT_DISPATCH_ENABLED), and
 * `evaluator` (post-hand-off PR review, PD-487/D-076 — inert unless EVALUATOR_ENABLED),
 * `conflicts` (mechanical merge-conflict resolver, PD-774/D-099 — inert unless CONFLICT_RESOLVER_ENABLED), and
 * `numbering` (the decision-numbering cycle, PD-498/D-078 — deterministic, no LLM; inert unless
 * DECISION_CONSOLIDATION_JOB_ENABLED).
 */
async function main(): Promise<void> {
  // The env-only config: each tunable's boot default (D-121).
  const bootConfig = loadConfig();
  logger.info({ model: bootConfig.model, repo: bootConfig.githubRepo }, 'agent-worker starting');

  installProxy(bootConfig);
  await ensureCheckout(bootConfig);

  // Fail fast if the shared dashboard DB isn't mounted where we expect.
  const db = openDb(bootConfig);
  db.prepare('SELECT 1').get();

  // PD-1006 (D-121): restart-only overrides (poll intervals) are taken once, here; live ones are
  // re-read by each pass via `effectiveConfig`. Then publish what we booted with, so
  // /devops/configure can show the env value beside the override — the web process can't read our env.
  const config = startupConfig(db, bootConfig);
  publishWorkerConfigBoot(db, bootConfig, config);

  setInterval(() => {
    void pullLatest(config);
  }, config.pullIntervalMs);

  // Release a deploy hold a Watchtower pre-update drain left behind (PD-802, D-105): a recreate just
  // swapped this container, and dispatch must resume now that the new process is up. Only the deploy
  // slot is cleared — a human's manual maintenance window is left alone.
  releaseDeployHoldOnStartup(db);

  // Liveness beacon the dashboard's Site Status reads (this worker never serves HTTP).
  startHeartbeat(db, config);

  // Job dispatch — start each agent-worker job over the shared infra above.
  startRefineJob(db, config);
  startAuditJob(db, config);
  const robot = startRobotJob(db, config);
  startEvaluatorJob(db, config);
  startConflictJob(db, config);
  startVisualJob(db, config);
  startSzzJob(db, config);
  startMaintenanceCoordinator(db, config);

  // PD-784/D-104: graceful stop. A deploy recreates this container with SIGTERM → (grace) → SIGKILL.
  // Before this, SIGKILL killed the worker mid-run, stranding `running` rows and skipping PD-736's
  // WIP push. Now SIGTERM asks the Robot loop to stop dispatching and abort its in-flight sessions;
  // each aborted session closes its run as a transient `interrupted` fault and pushes WIP (time-boxed)
  // — so nothing is left for the next boot's ownership sweep to reclaim. We wait, bounded, for the
  // drain and then exit; the bound must fit inside the compose `stop_grace_period`.
  installGracefulStop(robot, config.robot.shutdownDrainMs);

  logger.info('agent-worker ready');
}

/** Install the SIGTERM/SIGINT handler that drains the Robot loop then exits (PD-784/D-104). */
function installGracefulStop(robot: RobotLoopHandle, drainMs: number): void {
  let stopping = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping) return; // a second signal during the drain — let the first one finish
    stopping = true;
    logger.warn({ signal }, 'agent-worker: stop signal — draining the Robot loop');
    robot.shutdown.request(); // refuse new dispatch + abort in-flight sessions

    const deadline = Date.now() + drainMs;
    const poll = setInterval(() => {
      const drained = !robot.busy();
      if (drained || Date.now() >= deadline) {
        clearInterval(poll);
        logger.info({ drained }, 'agent-worker: Robot loop drained — exiting');
        process.exit(0);
      }
    }, 200);
    poll.unref(); // a pending drain poll must not, by itself, keep the process alive
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
}

main().catch((err) => {
  logger.error({ err }, 'agent-worker failed to start');
  process.exit(1);
});
