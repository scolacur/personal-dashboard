import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, type AgentWorkerConfig } from '../../shared/config';
import { ensureWorktree, removeWorktree, worktreeDirFor } from './workspace';

/** Records git invocations + chown targets so the clone sequence can be asserted. */
function recording() {
  const git: string[][] = [];
  const chowns: string[] = [];
  return {
    git,
    chowns,
    gitRunner: async (args: string[]) => {
      git.push(args);
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
    expect(wt).toEqual({ dir, branch: 'robot/220' });

    expect(r.git[0]).toEqual(['clone', '--depth', '1', 'https://github.com/scolacur/personal-dashboard.git', dir]);
    expect(r.git[1]).toEqual(['-C', dir, 'checkout', '-B', 'robot/220']);
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

  it('removeWorktree deletes the clone dir', async () => {
    const dir = worktreeDirFor(config, 'robot/1');
    mkdirSync(dir, { recursive: true });
    await removeWorktree(config, { dir, branch: 'robot/1' });
    expect(existsSync(dir)).toBe(false);
  });
});
