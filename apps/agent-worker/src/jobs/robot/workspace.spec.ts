import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, type AgentWorkerConfig } from '../../shared/config';
import { ensureWorktree, removeWorktree, worktreeDirFor } from './workspace';

/** A git runner that records invocations (and can be told to fail specific subcommands). */
function recordingGit(failOn: (args: string[]) => boolean = () => false) {
  const calls: string[][] = [];
  const git = async (args: string[]) => {
    calls.push(args);
    if (failOn(args)) throw new Error('boom');
  };
  return { git, calls };
}

describe('robot worktree lifecycle', () => {
  let root: string;
  let config: AgentWorkerConfig;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'robot-wt-'));
    config = loadConfig({ AGENT_WORKER_CHECKOUT_DIR: path.join(root, 'checkout'), ROBOT_WORKTREES_DIR: path.join(root, 'wt') });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('flattens the branch slash into the worktree dir name', () => {
    expect(worktreeDirFor(config, 'robot/220')).toBe(path.join(root, 'wt', 'robot-220'));
  });

  it('creates a worktree off origin/main on first use', async () => {
    const { git, calls } = recordingGit();
    const wt = await ensureWorktree(config, 'robot/220', git);
    expect(wt).toEqual({ dir: path.join(root, 'wt', 'robot-220'), branch: 'robot/220' });
    // fetch origin main, then worktree add -B
    expect(calls[0]).toEqual(['-C', config.checkoutDir, 'fetch', 'origin', 'main']);
    expect(calls[1]).toEqual(['-C', config.checkoutDir, 'worktree', 'add', '-B', 'robot/220', wt.dir, 'origin/main']);
    // no reset/clean on the create path
    expect(calls.some((c) => c.includes('reset'))).toBe(false);
  });

  it('pristine-cleans and re-points the branch on reuse (PD-340)', async () => {
    const dir = worktreeDirFor(config, 'robot/220');
    mkdirSync(path.join(dir, '.git'), { recursive: true }); // simulate an existing worktree
    const { git, calls } = recordingGit();
    await ensureWorktree(config, 'robot/220', git);
    const subs = calls.map((c) => c.slice(c.indexOf('-C') + 2)); // drop the `-C <dir>` prefix
    expect(subs).toContainEqual(['reset', '--hard']);
    expect(subs).toContainEqual(['clean', '-fd']); // note: no -x — keeps node_modules
    expect(subs).toContainEqual(['checkout', '-B', 'robot/220', 'origin/main']);
    expect(calls.some((c) => c.includes('add'))).toBe(false); // not re-created
  });

  it('tolerates a best-effort fetch failure and still proceeds', async () => {
    const { git, calls } = recordingGit((args) => args.includes('fetch'));
    await expect(ensureWorktree(config, 'robot/9', git)).resolves.toMatchObject({ branch: 'robot/9' });
    expect(calls.some((c) => c.includes('worktree') && c.includes('add'))).toBe(true);
  });

  it('removeWorktree never throws, even when git refuses', async () => {
    const { git } = recordingGit((args) => args.includes('worktree') && args.includes('remove'));
    await expect(
      removeWorktree(config, { dir: path.join(root, 'wt', 'robot-9'), branch: 'robot/9' }, git),
    ).resolves.toBeUndefined();
  });
});
