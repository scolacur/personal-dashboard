import type Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentWorkerConfig } from '../../shared/config';
import { logger } from '../../shared/logger';
import type { MaintenanceJobRunner } from '../maintenance/coordinator';
import { finishJobRun, startJobRun } from '../maintenance/job-runs-db';
import { runNumberingCycle, type CommandRunner, type CycleConfig, type CycleDeps } from './cycle';

const execFileAsync = promisify(execFile);

/** The `job_runs.job_name` this job records under, and the key its API routes take. */
export const CONSOLIDATION_JOB_NAME = 'decisions:consolidation';

/**
 * The Decision Consolidation job (PD-498, D-078) — deterministic, no LLM, no agent session.
 *
 * **Not self-scheduling.** It is registered with the maintenance coordinator and runs inside an
 * open maintenance hold; the coordinator owns the cadence, the drain and the window. What lives
 * here is the job's identity, its `job_runs` bookkeeping, and the shell runner it needs.
 */

/**
 * Robot runs currently in flight — the guard the cycle re-checks inside the hold.
 *
 * A run counts only if its TICKET is also still `working`, which is the same definition
 * `orphanedRunningRuns` uses to decide what a live run is. `status = 'running'` alone is not enough:
 * the runs table accumulates rows that never got a terminal status, and nothing ever clears them.
 *
 * Found in production, not in a test: on 2026-08-22 the NAS DB held one `running` row from
 * 2026-07-16 whose ticket (PD-380) had been `completed` for five weeks with `agent_state` NULL. The
 * stall reconciler cannot close it — it only looks at runs whose ticket is `working` — so the row is
 * permanent. Counting it would have meant no hold ever opened.
 */
export function inFlightRunCount(db: Database.Database): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM agent_runs r
         JOIN agent_tickets t ON t.id = r.ticket_id
        WHERE r.status = 'running'
          AND t.agent_state = 'working'`,
    )
    .get() as { n: number };
  return row.n;
}

/**
 * Strip the token, and its base64 Authorization form, out of anything on its way to a log or the
 * `job_runs.error` column.
 *
 * **Not optional here.** `execFile`'s error embeds the entire argv, and the auth below travels as a
 * `-c http.extraHeader=...` argument. A failed push would otherwise write the write-scoped token
 * into `job_runs.error`, which is served by `/api/jobs/...` and rendered on the Dev Ops page. Same
 * reasoning as `redactSecrets` in `shared/checkout.ts`, for the same class of mistake.
 */
export function redactToken(text: string, token: string): string {
  if (!token) return text;
  let out = text;
  for (const secret of [token, Buffer.from(`x-access-token:${token}`).toString('base64')]) {
    out = out.split(secret).join('***');
  }
  return out;
}

/**
 * git `-c` args carrying the WRITE token as an Authorization header, plus the proxy.
 *
 * Header rather than a token-in-URL, matching `shared/checkout.ts`: an `http.extraHeader` override
 * is per-invocation, so git never writes it into `.git/config` — which lives on a shared volume.
 * The proxy goes inline for the same reason the checkout does it, rather than relying on env alone.
 */
export function gitNetworkArgs(config: AgentWorkerConfig): string[] {
  const token = config.robot.writeToken;
  const auth = token
    ? ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`]
    : [];
  const proxy = config.httpsProxy
    ? ['-c', `http.proxy=${config.httpsProxy}`, '-c', `https.proxy=${config.httpsProxy}`]
    : [];
  return [...auth, ...proxy];
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
      // Fail fast on missing credentials instead of blocking forever on a prompt nobody can answer.
      GIT_TERMINAL_PROMPT: '0',
      ...(token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {}),
      ...(config.httpsProxy ? { HTTPS_PROXY: config.httpsProxy, HTTP_PROXY: config.httpsProxy } : {}),
    };
    try {
      const { stdout } = await execFileAsync(cmd, args, { env, cwd: opts?.cwd });
      return { stdout };
    } catch (err) {
      const e = err as { stdout?: string };
      if (typeof e.stdout === 'string' && e.stdout.length > 0) return { stdout: redactToken(e.stdout, token) };
      // Rethrow a REDACTED error and drop the original — its .cmd and .stack carry the argv too.
      throw new Error(redactToken(err instanceof Error ? err.message : String(err), token));
    }
  };
}

/**
 * The runner the coordinator invokes inside a hold.
 *
 * Returns the `job_runs.id` it recorded so the hold log can link to it, or `null` when there was
 * nothing to do — an empty inbox is the common case and should not litter the run list with rows
 * that say "did nothing".
 */
export function consolidationJobRunner(config: AgentWorkerConfig): MaintenanceJobRunner {
  const cycleConfig: CycleConfig = {
    repoRoot: config.checkoutDir,
    githubRepo: config.githubRepo,
    ciTimeoutMs: config.numbering.ciTimeoutMs,
    ciPollMs: config.numbering.ciPollMs,
    // The Robot's bot identity, reused: this job's commits are the same automation's, and giving it
    // a second identity would mean a second thing to keep in step with branch protection.
    botName: config.robot.botName,
    botEmail: config.robot.botEmail,
    baseBranch: config.numbering.baseBranch,
    gitNetworkArgs: gitNetworkArgs(config),
  };

  return async (db) => {
    const deps: CycleDeps = {
      run: defaultRunner(config),
      inFlightRuns: () => inFlightRunCount(db),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
    };

    const runId = startJobRun(db, CONSOLIDATION_JOB_NAME);
    try {
      const outcome = await runNumberingCycle(db, cycleConfig, deps);
      if (outcome.status === 'nothing-to-do') {
        // Recorded as `skipped` rather than deleted: "the hold ran and there was nothing to number"
        // is a real answer, and a hold log with no row for the job reads as a job that failed to
        // fire. `skipped` distinguishes the two.
        finishJobRun(db, runId, 'skipped', { message: 'no provisional decisions to number' });
        return runId;
      }
      const ok = outcome.status === 'merged';
      finishJobRun(
        db,
        runId,
        ok ? 'ok' : 'error',
        {
          outcome: outcome.status,
          ...('prNumber' in outcome ? { prNumber: outcome.prNumber } : {}),
          ...('assignments' in outcome ? { assigned: outcome.assignments.map((a) => `${a.from.id} → ${a.id}`) } : {}),
          ...('inFlight' in outcome ? { inFlight: outcome.inFlight } : {}),
        },
        ok ? null : `cycle ended as ${outcome.status}`,
      );
      return runId;
    } catch (err) {
      logger.error({ err }, 'consolidation: cycle threw');
      finishJobRun(db, runId, 'error', null, err instanceof Error ? err.message : String(err));
      return runId;
    }
  };
}
