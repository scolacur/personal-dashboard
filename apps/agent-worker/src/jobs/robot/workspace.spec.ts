import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, type AgentWorkerConfig } from '../../shared/config';
import { ensureWorktree, GitError, pruneWorktrees, removeWorktree, worktreeDirFor } from './workspace';

/**
 * Records git invocations + chown targets so the clone sequence can be asserted. By default the
 * branch is not on origin (`ls-remote --exit-code` exits 2); `remote: true` makes it exist, and
 * `respond` answers other commands (e.g. `rev-parse` for a kept clone).
 */
function recording(opts: { remote?: boolean | 'error'; respond?: (args: string[]) => string | undefined } = {}) {
  const git: string[][] = [];
  const chowns: string[] = [];
  return {
    git,
    chowns,
    gitRunner: async (args: string[]): Promise<string | void> => {
      git.push(args);
      if (args.includes('ls-remote')) {
        if (opts.remote === 'error') throw new GitError('fatal: unable to access github.com', 128);
        if (!opts.remote) throw new GitError('no matching ref', 2);
        return 'abc123\trefs/heads/x\n';
      }
      return opts.respond?.(args);
    },
    chownRunner: async (dir: string) => {
      chowns.push(dir);
    },
  };
}

describe('robot workspace lifecycle (per-ticket clone)', () => {
  let root: string;
  let config: AgentWorkerConfig;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'robot-wt-'));
    config = loadConfig({
      ROBOT_WORKTREES_DIR: path.join(root, 'wt'),
      ROBOT_CODING_UID: '1500',
      ROBOT_CODING_GID: '1500',
    });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('flattens the branch slash into the clone dir name', () => {
    expect(worktreeDirFor(config, 'robot/220')).toBe(path.join(root, 'wt', 'robot-220'));
  });

  it('produces a fresh shallow clone, cuts the branch, stamps identity, and chowns to the coder', async () => {
    const r = recording();
    const wt = await ensureWorktree(config, 'robot/220', r.gitRunner, r.chownRunner);
    const dir = path.join(root, 'wt', 'robot-220');
    expect(wt).toMatchObject({ dir, branch: 'robot/220' });

    expect(r.git[0]).toEqual(['clone', '--depth', '1', 'https://github.com/scolacur/personal-dashboard.git', dir]);
    expect(r.git[1]).toEqual(['-C', dir, 'ls-remote', '--exit-code', '--heads', 'origin', 'robot/220']);
    expect(r.git[2]).toEqual(['-C', dir, 'checkout', '-B', 'robot/220']);
    expect(wt.base).toBe('main');
    expect(r.git).toContainEqual(['-C', dir, 'config', 'user.name', config.robot.botName]);
    expect(r.git).toContainEqual(['-C', dir, 'config', 'user.email', config.robot.botEmail]);
    // never a worktree add (that was the old shared-checkout model)
    expect(r.git.some((c) => c.includes('worktree'))).toBe(false);
    // the whole clone is handed to the coding uid
    expect(r.chowns).toEqual([dir]);
  });

  it('removes any leftover clone before re-cloning (fresh = pristine, PD-340)', async () => {
    const dir = worktreeDirFor(config, 'robot/9');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'stale.txt'), 'dirty WIP from a prior run');
    const r = recording();
    await ensureWorktree(config, 'robot/9', r.gitRunner, r.chownRunner);
    expect(existsSync(path.join(dir, 'stale.txt'))).toBe(false); // wiped before clone
  });

  // ── PD-719: a clone outlives a run that did not push ─────────────────────────

  /** A kept clone on disk: a `.git`, and the previous run's hand-off markers. */
  function keptClone(branch: string) {
    const dir = worktreeDirFor(config, branch);
    mkdirSync(path.join(dir, '.git'), { recursive: true });
    mkdirSync(path.join(dir, '.robot'), { recursive: true });
    writeFileSync(path.join(dir, '.robot', 'verify-ok'), '');
    writeFileSync(path.join(dir, '.robot', 'ask-human'), 'old question');
    return dir;
  }

  it('reuses a kept clone on the same branch: keeps commits, drops uncommitted changes and old markers', async () => {
    const dir = keptClone('robot/t876');
    const r = recording({ respond: (a) => (a.includes('rev-parse') ? 'robot/t876\n' : undefined) });
    const wt = await ensureWorktree(config, 'robot/t876', r.gitRunner, r.chownRunner);

    expect(wt).toEqual({ dir, branch: 'robot/t876', base: 'reused' });
    expect(r.git.some((c) => c[0] === 'clone')).toBe(false); // the commits are not thrown away
    expect(r.git).toContainEqual(['-c', `safe.directory=${dir}`, '-C', dir, 'reset', '--hard', 'HEAD']);
    expect(r.git).toContainEqual(['-c', `safe.directory=${dir}`, '-C', dir, 'clean', '-fd']);
    // A stale verify-ok would make this run look handed off before it starts.
    expect(existsSync(path.join(dir, '.robot'))).toBe(false);
    expect(r.chowns).toEqual([dir]); // root rewrote files; ownership goes back to the coder
  });

  it('runs the reuse check as the owner of the clone, so root git is not refused as dubious ownership', async () => {
    const dir = keptClone('robot/5');
    const r = recording({ respond: (a) => (a.includes('rev-parse') ? 'robot/5\n' : undefined) });
    await ensureWorktree(config, 'robot/5', r.gitRunner, r.chownRunner);
    expect(r.git[0]).toEqual(['-c', `safe.directory=${dir}`, '-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']);
  });

  it('discards a kept clone that is on another branch, and clones fresh', async () => {
    const dir = keptClone('robot/7');
    const r = recording({ respond: (a) => (a.includes('rev-parse') ? 'robot/other\n' : undefined) });
    const wt = await ensureWorktree(config, 'robot/7', r.gitRunner, r.chownRunner);
    expect(wt.base).toBe('main');
    expect(r.git).toContainEqual(['clone', '--depth', '1', 'https://github.com/scolacur/personal-dashboard.git', dir]);
    expect(existsSync(path.join(dir, '.robot', 'verify-ok'))).toBe(false);
  });

  it('treats a clone whose branch cannot be read as unusable rather than as a match', async () => {
    keptClone('robot/8');
    const r = recording({
      respond: (a) => {
        if (a.includes('rev-parse')) throw new GitError('fatal: detected dubious ownership', 128);
        return undefined;
      },
    });
    const wt = await ensureWorktree(config, 'robot/8', r.gitRunner, r.chownRunner);
    expect(wt.base).toBe('main');
  });

  it('starts a fresh clone from the remote branch when it exists, so a rework pushes fast-forward', async () => {
    const r = recording({ remote: true });
    const wt = await ensureWorktree(config, 'robot/220', r.gitRunner, r.chownRunner);
    const dir = path.join(root, 'wt', 'robot-220');
    expect(wt.base).toBe('remote');
    expect(r.git).toContainEqual(['-C', dir, 'fetch', '--depth', '50', 'origin', 'robot/220']);
    expect(r.git).toContainEqual(['-C', dir, 'checkout', '-B', 'robot/220', 'FETCH_HEAD']);
    expect(r.git).not.toContainEqual(['-C', dir, 'checkout', '-B', 'robot/220']);
  });

  it('fails the dispatch, rather than silently basing on main, when the remote cannot be checked', async () => {
    const r = recording({ remote: 'error' });
    await expect(ensureWorktree(config, 'robot/220', r.gitRunner, r.chownRunner)).rejects.toThrow(/unable to access/);
  });

  it('pruneWorktrees removes clones of tickets the Robot no longer has, and keeps the rest', () => {
    const keep = worktreeDirFor(config, 'robot/t1');
    const drop = worktreeDirFor(config, 'robot/t2');
    mkdirSync(keep, { recursive: true });
    mkdirSync(drop, { recursive: true });
    expect(pruneWorktrees(config, new Set([keep]))).toEqual([drop]);
    expect(existsSync(keep)).toBe(true);
    expect(existsSync(drop)).toBe(false);
  });

  it('pruneWorktrees is a no-op when there is no worktrees dir yet', () => {
    expect(pruneWorktrees(config, new Set())).toEqual([]);
  });

  it('removeWorktree deletes the clone dir', async () => {
    const dir = worktreeDirFor(config, 'robot/1');
    mkdirSync(dir, { recursive: true });
    await removeWorktree(config, { dir, branch: 'robot/1' });
    expect(existsSync(dir)).toBe(false);
  });
});
