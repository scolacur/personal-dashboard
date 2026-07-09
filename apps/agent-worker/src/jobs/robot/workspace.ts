import { execFile } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AgentWorkerConfig } from '../../shared/config';
import { authArgs, authHeaderValue, proxyGitArgs } from '../../shared/checkout';
import { logger } from '../../shared/logger';

const run = promisify(execFile);

/**
 * Per-ticket git worktree lifecycle for the Robot loop (D-055, PD-342). Each run works in its
 * OWN worktree branched off the grounding checkout, so a Robot never mutates the shared
 * checkout the Refine/Audit jobs ground against and two Robots never collide.
 *
 * PD-340 pristine-tree hygiene is applied on REUSE: a retry starts from a clean tree
 * (`git reset --hard` + `git clean -fd`, no `-x` so gitignored `node_modules` survives),
 * then resets the branch to a fresh `origin/main`. This is the self-healing fix for the
 * #220 dirty-WIP freeze, applied to the worktree model.
 */

export interface Worktree {
  /** Absolute worktree directory. */
  dir: string;
  /** The branch checked out there (`robot/<n>`). */
  branch: string;
}

/** Runs one git invocation (secrets redacted on failure). Injectable for tests. */
export type GitRunner = (args: string[]) => Promise<void>;

/** Default runner: real git with the read token + proxy attached inline (never persisted to
 *  `.git/config`), failing fast instead of prompting. Mirrors checkout.ts's runGit. */
export function defaultGitRunner(config: AgentWorkerConfig): GitRunner {
  const secrets = [config.githubReadToken, authHeaderValue(config.githubReadToken)].filter(Boolean);
  return async (args: string[]) => {
    const full = [...authArgs(config), ...proxyGitArgs(config), ...args];
    try {
      await run('git', full, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    } catch (err) {
      let msg = err instanceof Error ? err.message : String(err);
      for (const s of secrets) msg = msg.split(s).join('***');
      throw new Error(msg);
    }
  };
}

/** The worktree directory for a branch: `<worktreesDir>/<branch-with-slash-flattened>`. */
export function worktreeDirFor(config: AgentWorkerConfig, branch: string): string {
  return path.join(config.robot.worktreesDir, branch.replace(/\//g, '-'));
}

/**
 * Ensure a clean worktree exists for `branch`, reset to the latest `origin/main`, and return
 * it. First attempt creates it; a reuse pristine-cleans it (PD-340) before resetting the
 * branch. The `origin` fetch is best-effort (like `pullLatest`) — a stale-but-present
 * `origin/main` is better than failing the run over a transient network blip.
 */
export async function ensureWorktree(
  config: AgentWorkerConfig,
  branch: string,
  git: GitRunner = defaultGitRunner(config),
): Promise<Worktree> {
  const dir = worktreeDirFor(config, branch);

  // Refresh origin/main in the grounding checkout (single-branch clone → default refspec
  // updates refs/remotes/origin/main). Best-effort.
  try {
    await git(['-C', config.checkoutDir, 'fetch', 'origin', 'main']);
  } catch (err) {
    logger.warn({ err }, 'robot: origin fetch failed — using existing origin/main');
  }

  if (existsSync(path.join(dir, '.git'))) {
    // Reuse: PD-340 pristine hygiene, then re-point the branch at fresh main. `-x` is
    // deliberately omitted so gitignored node_modules survives the clean (an npm ci per run
    // would be wasteful; the coding session re-runs `npm ci` itself in its verify step).
    await git(['-C', dir, 'reset', '--hard']);
    await git(['-C', dir, 'clean', '-fd']);
    await git(['-C', dir, 'checkout', '-B', branch, 'origin/main']);
    logger.info({ dir, branch }, 'robot: reused worktree (pristine)');
  } else {
    await git(['-C', config.checkoutDir, 'worktree', 'add', '-B', branch, dir, 'origin/main']);
    logger.info({ dir, branch }, 'robot: created worktree');
  }

  return { dir, branch };
}

/**
 * Tear a worktree down (best-effort). `git worktree remove` unregisters it; a hard rm is the
 * fallback if git refuses (dirty tree). Never throws — cleanup failure must not fail a run.
 */
export async function removeWorktree(
  config: AgentWorkerConfig,
  worktree: Worktree,
  git: GitRunner = defaultGitRunner(config),
): Promise<void> {
  try {
    await git(['-C', config.checkoutDir, 'worktree', 'remove', '--force', worktree.dir]);
  } catch (err) {
    logger.warn({ err, dir: worktree.dir }, 'robot: worktree remove failed — hard rm');
    try {
      rmSync(worktree.dir, { recursive: true, force: true });
    } catch {
      // give up — a leftover dir is pristine-cleaned on next reuse anyway
    }
  }
}
