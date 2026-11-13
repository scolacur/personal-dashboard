import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
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
 * works in and root never contends with it. (The retired Sortie runtime also cloned per workspace.)
 *
 * **A clone outlives a run that did not push (PD-719).** It used to be deleted after every run and
 * re-cloned from `main` on every dispatch, so a run that committed and then parked (ask-human, a
 * fault) lost its commit before the human even answered, and a rework of an open PR started from
 * `main` instead of the PR's branch. Now:
 *  - a run that did not hand off keeps its clone, and the next dispatch REUSES it: committed work
 *    survives, uncommitted debris and the previous run's `.robot/` markers do not (PD-340's hygiene,
 *    applied to what a crashed run leaves behind rather than to the whole tree);
 *  - a fresh clone starts from `origin/<branch>` when that exists, so a rework pushes fast-forward;
 *  - clones of tickets that left the Robot's Queue are pruned each cycle (`pruneWorktrees`).
 */

export interface Worktree {
  /** Absolute clone directory. */
  dir: string;
  /** The branch created there (`robot/<n>`). */
  branch: string;
  /**
   * Where the branch came from (PD-719): a kept clone from an earlier run of this ticket, the
   * branch already on GitHub, or a fresh cut from `main`. Optional so test doubles can omit it.
   */
  base?: 'reused' | 'remote' | 'main';
}

/** A git failure that keeps the exit code, so callers can tell "no such ref" from "network down". */
export class GitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/**
 * Runs one git invocation and returns its stdout (secrets redacted on failure; throws `GitError`).
 * Injectable for tests; a double may return nothing, which reads as empty output.
 */
export type GitRunner = (args: string[]) => Promise<string | void>;
/** Recursively chowns the clone to the coding uid (no-op in dev). Injectable for tests. */
export type ChownRunner = (dir: string) => Promise<void>;

/** Default runner: real git with the read token + proxy attached inline (never persisted to
 *  `.git/config`), failing fast instead of prompting. Mirrors checkout.ts's runGit. */
export function defaultGitRunner(config: AgentWorkerConfig): GitRunner {
  const secrets = [config.githubReadToken, authHeaderValue(config.githubReadToken)].filter(Boolean);
  return async (args: string[]) => {
    const full = [...authArgs(config), ...proxyGitArgs(config), ...args];
    try {
      const { stdout } = await run('git', full, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      return stdout;
    } catch (err) {
      let msg = err instanceof Error ? err.message : String(err);
      for (const s of secrets) msg = msg.split(s).join('***');
      const code = (err as { code?: unknown }).code;
      throw new GitError(msg, typeof code === 'number' ? code : null);
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

/** How many commits of an existing remote branch to fetch: enough to push fast-forward on top. */
const REMOTE_BRANCH_DEPTH = 50;

/** The previous run's hand-off markers. Gitignored, so `git clean` would leave them. */
const MARKER_DIR = '.robot';

/**
 * Git args that let the loop (root) operate on a clone the Robot's uid owns. Since git 2.35.2 a
 * repo owned by another user is refused as "dubious ownership"; without this, every reuse check
 * would fail closed and quietly become a fresh clone, which is the bug PD-719 fixes. Scoped to the
 * one directory, passed per call, never written to any config.
 */
const asOwnerOf = (dir: string): string[] => ['-c', `safe.directory=${dir}`, '-C', dir];

/**
 * The branch checked out in `dir`, or null when it is not a usable clone. Any failure (missing,
 * not a repo, detached, unreadable) reads as unusable, never as a match.
 */
async function currentBranch(git: GitRunner, dir: string): Promise<string | null> {
  if (!existsSync(path.join(dir, '.git'))) return null;
  try {
    const out = (await git([...asOwnerOf(dir), 'rev-parse', '--abbrev-ref', 'HEAD'])) ?? '';
    const name = out.trim();
    return name && name !== 'HEAD' ? name : null;
  } catch {
    return null;
  }
}

/**
 * Whether `branch` exists on origin. `ls-remote --exit-code` exits 2 for "no such ref"; any other
 * failure is rethrown, because silently falling back to `main` is exactly how a rework used to lose
 * its PR's commits. A failed dispatch retries; a wrong base does not announce itself.
 */
async function remoteBranchExists(git: GitRunner, dir: string, branch: string): Promise<boolean> {
  try {
    await git(['-C', dir, 'ls-remote', '--exit-code', '--heads', 'origin', branch]);
    return true;
  } catch (err) {
    if (err instanceof GitError && err.exitCode === 2) return false;
    throw err;
  }
}

/**
 * The clone a run works in, coding-uid-owned (PD-719 changed what "fresh" means — see the header):
 *
 * 1. **Reuse** a kept clone already on `branch`: discard uncommitted changes and the previous run's
 *    `.robot/` markers, keep the commits.
 * 2. Otherwise a **fresh shallow clone** of `main`, then the branch: from `origin/<branch>` when it
 *    exists (a rework, or a run that pushed before parking), else cut from `main`. A clone that was
 *    there but unusable is discarded with a warning, never silently.
 *
 * The loop runs this as root; the final `chown` hands the tree to the Robot so its commit/push work.
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

  if ((await currentBranch(git, dir)) === branch) {
    // Committed work stays; a crashed run's uncommitted edits do not. `clean -fd` leaves ignored
    // files (node_modules survives, which saves the next `npm ci`), so the markers go explicitly:
    // a stale `verify-ok` would otherwise make this run look handed off before it starts.
    await git([...asOwnerOf(dir), 'reset', '--hard', 'HEAD']);
    await git([...asOwnerOf(dir), 'clean', '-fd']);
    rmSync(path.join(dir, MARKER_DIR), { recursive: true, force: true });
    await chown(dir); // root just rewrote files; hand them back
    logger.info({ dir, branch }, 'robot: reusing the kept clone — committed work from the last run carries over');
    return { dir, branch, base: 'reused' };
  }

  if (existsSync(dir)) {
    logger.warn(
      { dir, branch },
      'robot: discarding an unusable clone (not a repo, or on another branch) — any local work in it is lost',
    );
  }
  rmSync(dir, { recursive: true, force: true });

  // Shallow clone (the Robot makes one change off main; it needs no history). auth+proxy are
  // prepended by the runner. Then the working branch, and the committer identity now, while we're
  // still root — the config write lands before the chown.
  await git(['clone', '--depth', '1', cloneUrl(config), dir]);
  let base: 'remote' | 'main' = 'main';
  if (await remoteBranchExists(git, dir, branch)) {
    await git(['-C', dir, 'fetch', '--depth', String(REMOTE_BRANCH_DEPTH), 'origin', branch]);
    await git(['-C', dir, 'checkout', '-B', branch, 'FETCH_HEAD']);
    base = 'remote';
  } else {
    await git(['-C', dir, 'checkout', '-B', branch]);
  }
  await git(['-C', dir, 'config', 'user.name', config.robot.botName]);
  await git(['-C', dir, 'config', 'user.email', config.robot.botEmail]);

  // Hand the whole clone to the coding uid so the dropped Robot can write/commit/push in it.
  await chown(dir);

  logger.info({ dir, branch, base }, base === 'remote' ? 'robot: fresh clone of the existing remote branch ready' : 'robot: fresh clone ready');
  return { dir, branch, base };
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

/**
 * Delete the kept clones of tickets the Robot no longer has (PD-719). Since a run that did not hand
 * off now keeps its clone, something must remove the clone of a ticket that then leaves the Queue,
 * is reassigned, or completes, or they accumulate (each one carries a node_modules).
 *
 * `keepDirs` is every clone dir for a ticket still `queue ∧ robot`. The loop calls this at the top
 * of a cycle, before any dispatch; cycles never overlap, so nothing is mid-run. Best-effort: a
 * failure is logged and the clone is retried next cycle. Returns the dirs removed.
 */
export function pruneWorktrees(config: AgentWorkerConfig, keepDirs: ReadonlySet<string>): string[] {
  const root = config.robot.worktreesDir;
  if (!existsSync(root)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(root)) {
    const dir = path.join(root, name);
    if (keepDirs.has(dir)) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch (err) {
      logger.warn({ err, dir }, 'robot: pruning a stale clone failed — will retry next cycle');
    }
  }
  if (removed.length > 0) logger.info({ removed }, 'robot: pruned clones of tickets no longer in the Robot queue');
  return removed;
}

