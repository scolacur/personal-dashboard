import { execFile } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AgentWorkerConfig } from '../../shared/config';
import { authArgs, authHeaderValue, cloneUrl, proxyGitArgs } from '../../shared/checkout';
import { logger } from '../../shared/logger';

const run = promisify(execFile);

/**
 * Per-ticket workspace lifecycle for the Robot loop (D-055, PD-342).
 *
 * Each run gets its OWN fresh CLONE (not a worktree off the shared grounding checkout). This is
 * deliberate: under the uid-split, the coding session runs as a low-priv uid and must be able to
 * commit — but a worktree shares the grounding checkout's `.git` (objects/refs/worktree metadata),
 * which the loop creates as root, so the Robot couldn't write it, and chowning the shared `.git`
 * to the Robot breaks the root loop's own git. A standalone clone sidesteps all of that: the loop
 * (root) clones, then `chown`s the WHOLE clone to the coding uid, so the Robot owns the one repo it
 * works in and root never contends with it. (This is also how Sortie worked — clone per workspace.)
 *
 * Fresh clone every dispatch ⇒ PD-340 pristine-tree hygiene is automatic (no dirty WIP can carry
 * over). C1 runs are first-attempt/pristine; branch reuse for review-rework is a later slice.
 */

export interface Worktree {
  /** Absolute clone directory. */
  dir: string;
  /** The branch created there (`robot/<n>`). */
  branch: string;
}

/** Runs one git invocation (secrets redacted on failure). Injectable for tests. */
export type GitRunner = (args: string[]) => Promise<void>;
/** Recursively chowns the clone to the coding uid (no-op in dev). Injectable for tests. */
export type ChownRunner = (dir: string) => Promise<void>;

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

/** Default chown: hand the clone to the coding uid/gid so the dropped Robot owns it. A no-op when
 *  no coding uid is configured (dev — the session inherits the current uid, which already owns it). */
export function defaultChown(config: AgentWorkerConfig): ChownRunner {
  const { codingUid, codingGid } = config.robot;
  return async (dir: string) => {
    if (codingUid === undefined) return;
    await run('chown', ['-R', `${codingUid}:${codingGid ?? codingUid}`, dir]);
  };
}

/** The clone directory for a branch: `<worktreesDir>/<branch-with-slash-flattened>`. */
export function worktreeDirFor(config: AgentWorkerConfig, branch: string): string {
  return path.join(config.robot.worktreesDir, branch.replace(/\//g, '-'));
}

/**
 * Produce a fresh, coding-uid-owned clone for `branch` and return it. Any prior clone at the same
 * path is removed first (fresh = pristine). The loop runs this as root; the final `chown` transfers
 * ownership to the Robot so its subsequent commit/push succeed.
 */
export async function ensureWorktree(
  config: AgentWorkerConfig,
  branch: string,
  git: GitRunner = defaultGitRunner(config),
  chown: ChownRunner = defaultChown(config),
): Promise<Worktree> {
  const dir = worktreeDirFor(config, branch);

  // The loop (root) owns the parent worktrees dir; create it if absent so `git clone` has a
  // place to land. Per-clone ownership is handed to the coding uid below.
  mkdirSync(config.robot.worktreesDir, { recursive: true });

  // Fresh every time — remove any leftover clone (root can rm the coding-uid-owned tree).
  rmSync(dir, { recursive: true, force: true });

  // Shallow clone (the Robot makes one change off main; it needs no history). auth+proxy are
  // prepended by the runner. Then cut the working branch and stamp the committer identity now,
  // while we're still root — the config write lands before the chown.
  await git(['clone', '--depth', '1', cloneUrl(config), dir]);
  await git(['-C', dir, 'checkout', '-B', branch]);
  await git(['-C', dir, 'config', 'user.name', config.robot.botName]);
  await git(['-C', dir, 'config', 'user.email', config.robot.botEmail]);

  // Hand the whole clone to the coding uid so the dropped Robot can write/commit/push in it.
  await chown(dir);

  logger.info({ dir, branch }, 'robot: fresh clone ready');
  return { dir, branch };
}

/**
 * Tear a clone down (best-effort). It's a standalone clone, so a plain recursive rm is all that's
 * needed (root can remove the coding-uid-owned tree). Never throws — cleanup must not fail a run.
 */
export async function removeWorktree(_config: AgentWorkerConfig, worktree: Worktree): Promise<void> {
  try {
    rmSync(worktree.dir, { recursive: true, force: true });
  } catch (err) {
    logger.warn({ err, dir: worktree.dir }, 'robot: clone remove failed');
  }
}
