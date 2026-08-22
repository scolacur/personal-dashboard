import type Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentWorkerConfig } from '../../shared/config';
import { logger } from '../../shared/logger';
import { runNumberingCycle, type CommandRunner, type CycleConfig, type CycleDeps } from './cycle';

const execFileAsync = promisify(execFile);

/**
 * The decision-numbering cycle job (PD-498, D-078) — deterministic, no LLM, no agent session.
 *
 * Lives beside the LLM jobs in `jobs/` because it shares the same host: the checkout, the proxy, the
 * DB handle, and the maintenance hold on the Robot loop. It is not an agent, and the folder name
 * says `number-decisions` rather than anything agent-flavoured for that reason.
 */

/** Robot runs currently in flight — what the drain waits on. */
export function inFlightRunCount(db: Database.Database): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE status = 'running'").get() as { n: number };
  return row.n;
}

/**
 * `execFile`, with the write token and proxy attached.
 *
 * Tolerates a non-zero exit and returns whatever was written: `gh pr checks` exits non-zero whenever
 * a check is failing OR merely pending, so treating exit code as failure would turn "CI is still
 * running" into a crashed cycle. The callers read the text, not the status.
 */
export function defaultRunner(config: AgentWorkerConfig): CommandRunner {
  return async (cmd, args, opts) => {
    // The WRITE token — this job pushes a branch, opens a PR, and merges it. The read-only
    // grounding token cannot do any of those.
    const token = config.robot.writeToken;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      ...(token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {}),
      ...(config.httpsProxy ? { HTTPS_PROXY: config.httpsProxy, HTTP_PROXY: config.httpsProxy } : {}),
    };
    try {
      const { stdout } = await execFileAsync(cmd, args, { env, cwd: opts?.cwd });
      return { stdout };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      if (typeof e.stdout === 'string' && e.stdout.length > 0) return { stdout: e.stdout };
      throw err;
    }
  };
}

/**
 * Start the numbering cycle. Inert unless `NUMBERING_CYCLE_ENABLED=1`, matching how the Robot loop
 * and the Evaluator ship (D-076): a job that rewrites the decision log repo-wide and admin-merges
 * its own PR does not turn itself on by arriving in an image.
 */
export function startNumberingCycleJob(db: Database.Database, config: AgentWorkerConfig): void {
  if (!config.numbering.enabled) {
    logger.info('numbering cycle: disabled (NUMBERING_CYCLE_ENABLED is not set) — not scheduling');
    return;
  }

  const cycleConfig: CycleConfig = {
    repoRoot: config.checkoutDir,
    githubRepo: config.githubRepo,
    // Same bound a stalled run gets (D-078): the drain is what the ~2h worst case refers to.
    drainTimeoutMs: config.robot.stallThresholdMs,
    drainPollMs: config.numbering.drainPollMs,
    ciTimeoutMs: config.numbering.ciTimeoutMs,
    ciPollMs: config.numbering.ciPollMs,
  };
  const deps: CycleDeps = {
    run: defaultRunner(config),
    inFlightRuns: () => inFlightRunCount(db),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };

  let running = false;
  setInterval(() => {
    if (running) return; // a cycle can outlast its own interval — the drain alone is bounded at ~2h
    running = true;
    void runNumberingCycle(db, cycleConfig, deps)
      .then((outcome) => {
        if (outcome.status !== 'nothing-to-do') logger.info({ outcome: outcome.status }, 'numbering: cycle finished');
      })
      .catch((err) => logger.error({ err }, 'numbering: cycle failed'))
      .finally(() => {
        running = false;
      });
  }, config.numbering.intervalMs);

  logger.info({ intervalMs: config.numbering.intervalMs }, 'numbering cycle job ready');
}
