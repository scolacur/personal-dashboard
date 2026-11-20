import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentWorkerConfig } from '../../shared/config';
import { authHeaderValue, proxyGitArgs } from '../../shared/checkout';
import { allowedCodingEnv } from '../robot/session';
import { classifyConflict, parseSensitivePaths, unmergedFromStatus, type ConflictVerdict } from './classify';

/**
 * Resolve one conflicted PR branch against main (PD-774, D-099). The steps:
 *   1. clone, check out the PR branch, merge `origin/main` with diff3 markers (merge, never rebase:
 *      the branch's history is left alone, so a session still working on it can just pull);
 *   2. classify every conflicted file; any refusal aborts with nothing pushed;
 *   3. apply the unions, take main's side of generated files and regenerate them;
 *   4. commit, run `npm ci && npm run verify`, and push only if it is green, as a plain
 *      fast-forward push (a branch that moved meanwhile rejects it, and the next pass retries).
 *
 * **Everything that executes the PR's code runs dropped** to the Robot's uid with the allowlisted
 * env (PD-777): the regenerate step and verify both run the branch's own scripts, which nobody has
 * reviewed yet. Only git runs as the worker, and the write token reaches git as a per-call header,
 * never the environment or `.git/config`.
 */

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export interface ExecOpts {
  cwd?: string;
  /** Run as the Robot's uid with the allowlisted env (the PR's own code). */
  dropped?: boolean;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}
/** Runs a command and never throws: a failure is a non-zero code. Injectable for tests. */
export type Exec = (cmd: string, args: string[], opts?: ExecOpts) => Promise<ExecResult>;

export type ResolveOutcome =
  | { kind: 'resolved'; files: ConflictVerdict[]; mergeSha: string }
  | { kind: 'refused'; reason: string; files: ConflictVerdict[] }
  | { kind: 'verify-failed'; reason: string; files: ConflictVerdict[] }
  | { kind: 'raced'; reason: string }
  | { kind: 'error'; reason: string };

export interface ResolveTarget {
  repo: string;
  prNumber: number;
  branch: string;
  /** The head the decision was made on. A different head on the clone means the branch moved. */
  headSha: string;
}

/** Long enough for a cold `npm ci` plus the whole verify on the NAS. */
const VERIFY_TIMEOUT_MS = 30 * 60_000;
const TAIL = 1500;
const tail = (s: string) => (s.length > TAIL ? `…${s.slice(-TAIL)}` : s);

export function resolverDir(config: AgentWorkerConfig, prNumber: number): string {
  return path.join(config.dataDir, 'conflict-resolver', `pr-${prNumber}`);
}

/** The env the PR's own code runs with: the allowlist, the proxy, the coding home. No tokens. */
export function droppedEnv(config: AgentWorkerConfig): Record<string, string | undefined> {
  const { codingUid, codingHome } = config.robot;
  return {
    ...allowedCodingEnv(process.env),
    ...(config.httpsProxy
      ? {
          HTTPS_PROXY: config.httpsProxy,
          HTTP_PROXY: config.httpsProxy,
          https_proxy: config.httpsProxy,
          http_proxy: config.httpsProxy,
          NODE_USE_ENV_PROXY: '1',
        }
      : {}),
    ...(codingUid !== undefined ? { HOME: codingHome, USER: 'robot', LOGNAME: 'robot' } : {}),
  };
}

export function defaultExec(config: AgentWorkerConfig): Exec {
  const { codingUid, codingGid } = config.robot;
  return (cmd, args, opts = {}) =>
    new Promise((resolve) => {
      const dropUid = opts.dropped && codingUid !== undefined;
      execFile(
        cmd,
        args,
        {
          cwd: opts.cwd,
          env: opts.dropped ? droppedEnv(config) : { ...process.env, GIT_TERMINAL_PROMPT: '0', ...opts.env },
          timeout: opts.timeoutMs ?? 5 * 60_000,
          maxBuffer: 64 * 1024 * 1024,
          ...(dropUid ? { uid: codingUid, gid: codingGid ?? codingUid } : {}),
        },
        (err, stdout, stderr) => {
          const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
          resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        },
      );
    });
}

function redact(text: string, token: string): string {
  let out = text;
  for (const s of [token, authHeaderValue(token)]) if (s) out = out.split(s).join('***');
  return out;
}

export async function resolveConflicts(
  config: AgentWorkerConfig,
  target: ResolveTarget,
  exec: Exec = defaultExec(config),
  /** Injectable so tests can resolve against a local bare repo. */
  remoteUrl: string = `https://github.com/${target.repo}.git`,
): Promise<ResolveOutcome> {
  const token = config.robot.writeToken;
  if (!token) return { kind: 'error', reason: 'no write token (ROBOT_GITHUB_TOKEN) to push with' };
  const dir = resolverDir(config, target.prNumber);
  const auth = ['-c', `http.extraHeader=Authorization: Basic ${authHeaderValue(token)}`, ...proxyGitArgs(config)];
  const inDir = ['-c', `safe.directory=${dir}`, '-C', dir];
  const git = async (args: string[], remote = false) => {
    const r = await exec('git', [...(remote ? auth : []), ...inDir, ...args]);
    return { ...r, stdout: redact(r.stdout, token), stderr: redact(r.stderr, token) };
  };

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.dirname(dir), { recursive: true });
  try {
    const clone = await exec('git', [...auth, 'clone', '--no-tags', remoteUrl, dir]);
    if (clone.code !== 0) return { kind: 'error', reason: `clone failed: ${tail(redact(clone.stderr, token))}` };

    const co = await git(['checkout', '-B', target.branch, `origin/${target.branch}`]);
    if (co.code !== 0) return { kind: 'error', reason: `checkout failed: ${tail(co.stderr)}` };
    const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    if (head !== target.headSha) return { kind: 'raced', reason: `branch moved (${head.slice(0, 7)} ≠ ${target.headSha.slice(0, 7)})` };

    await git(['config', 'user.name', config.robot.botName]);
    await git(['config', 'user.email', config.robot.botEmail]);

    const merge = await git(['-c', 'merge.conflictStyle=diff3', 'merge', '--no-ff', '--no-edit', 'origin/main']);
    const unmerged = unmergedFromStatus((await git(['status', '--porcelain=v1'])).stdout);
    if (merge.code !== 0 && unmerged.length === 0) {
      return { kind: 'error', reason: `merge failed without conflicts: ${tail(merge.stderr || merge.stdout)}` };
    }

    let sensitiveText = '';
    try {
      sensitiveText = readFileSync(path.join(dir, '.github/sensitive-paths.txt'), 'utf8');
    } catch {
      // No list on this branch's merge result means nothing is known to be safe.
      return { kind: 'refused', reason: 'no .github/sensitive-paths.txt to judge against', files: [] };
    }
    const sensitive = parseSensitivePaths(sensitiveText);

    const verdicts = unmerged.map(({ status, path: p }) => {
      let content: string | null = null;
      try {
        content = readFileSync(path.join(dir, p), 'utf8');
      } catch {
        content = null;
      }
      return classifyConflict(p, status, content, sensitive);
    });
    const refusals = verdicts.filter((v) => v.kind === 'refuse');
    if (refusals.length > 0) {
      await git(['merge', '--abort']);
      return {
        kind: 'refused',
        reason: refusals.map((r) => `${r.path}: ${r.kind === 'refuse' ? r.reason : ''}`).join('; '),
        files: verdicts,
      };
    }

    for (const v of verdicts) {
      if (v.kind === 'union') writeFileSync(path.join(dir, v.path), v.content, 'utf8');
      // Main's side, then regenerate: the generator rebuilds it from the merged sources.
      if (v.kind === 'regenerate') await git(['checkout', '--theirs', '--', v.path]);
    }

    // From here on the PR's own code runs, so the clone belongs to the dropped uid.
    if (config.robot.codingUid !== undefined) {
      await exec('chown', ['-R', `${config.robot.codingUid}:${config.robot.codingGid ?? config.robot.codingUid}`, dir]);
    }
    const install = await exec('npm', ['ci'], { cwd: dir, dropped: true, timeoutMs: VERIFY_TIMEOUT_MS });
    if (install.code !== 0) return { kind: 'verify-failed', reason: `npm ci failed: ${tail(install.stderr)}`, files: verdicts };
    if (verdicts.some((v) => v.kind === 'regenerate')) {
      const gen = await exec('npm', ['run', 'decisions:index'], { cwd: dir, dropped: true });
      if (gen.code !== 0) return { kind: 'verify-failed', reason: `decisions:index failed: ${tail(gen.stderr)}`, files: verdicts };
    }

    const add = await git(['add', '--', ...verdicts.map((v) => v.path)]);
    if (add.code !== 0) return { kind: 'error', reason: `git add failed: ${tail(add.stderr)}` };
    const summary = verdicts.map((v) => `${v.path} (${v.kind === 'union' ? 'kept both sides' : 'regenerated'})`).join(', ');
    const commit = await git(['commit', '--no-edit', '-m', `Merge main into ${target.branch}\n\nAuto-resolved (PD-774): ${summary || 'no conflicted files'}`]);
    if (commit.code !== 0) return { kind: 'error', reason: `commit failed: ${tail(commit.stderr || commit.stdout)}` };

    const verify = await exec('npm', ['run', 'verify'], { cwd: dir, dropped: true, timeoutMs: VERIFY_TIMEOUT_MS });
    if (verify.code !== 0) {
      return { kind: 'verify-failed', reason: `verify failed: ${tail(verify.stdout + verify.stderr)}`, files: verdicts };
    }

    const mergeSha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const push = await git(['push', 'origin', `HEAD:refs/heads/${target.branch}`], true);
    if (push.code !== 0) {
      return /rejected|non-fast-forward|fetch first/.test(push.stderr)
        ? { kind: 'raced', reason: 'branch moved during the merge; retrying on the next pass' }
        : { kind: 'error', reason: `push failed: ${tail(push.stderr)}` };
    }
    return { kind: 'resolved', files: verdicts, mergeSha };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Comment on the PR saying what was resolved (best effort: a failed comment does not undo a push). */
export async function commentResolved(
  config: AgentWorkerConfig,
  target: ResolveTarget,
  outcome: Extract<ResolveOutcome, { kind: 'resolved' }>,
  exec: Exec = defaultExec(config),
): Promise<void> {
  const lines = outcome.files.map((v) => `- \`${v.path}\`: ${v.kind === 'union' ? 'both sides only added lines; kept both, main first' : 'generated; regenerated from the merged sources'}`);
  const body = [
    `Merged \`main\` into this branch and resolved the conflicts mechanically (PD-774). \`npm run verify\` passed before pushing.`,
    '',
    ...lines,
    '',
    'CI and review-gate run again on the new head.',
  ].join('\n');
  await exec('gh', ['pr', 'comment', String(target.prNumber), '--repo', target.repo, '--body', body], {
    env: {
      GH_TOKEN: config.robot.writeToken,
      GITHUB_TOKEN: config.robot.writeToken,
      ...(config.httpsProxy ? { HTTPS_PROXY: config.httpsProxy, HTTP_PROXY: config.httpsProxy } : {}),
    },
  });
}
