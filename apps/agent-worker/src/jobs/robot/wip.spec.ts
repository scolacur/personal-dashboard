import { describe, it, expect } from 'vitest';
import { loadConfig, type AgentWorkerConfig } from '../../shared/config';
import { GitError, type GitRunner, type Worktree } from './workspace';
import { deleteWipRef, pushWip, wipRefName } from './wip';

const config: AgentWorkerConfig = loadConfig({});
const worktree: Worktree = { dir: '/clone/robot-t42', branch: 'robot/t42' };

/**
 * A fake GitRunner that answers just the commands pushWip/deleteWipRef issue:
 *  - `diff --cached --quiet` throws exit 1 when `staged`, else returns (exit 0 = clean);
 *  - `rev-parse HEAD` / `rev-parse origin/main` return the configured shas;
 *  - `push` throws when `pushFails`.
 * Records every invocation for assertions.
 */
function fakeGit(opts: { staged?: boolean; headSha?: string; mainSha?: string; pushFails?: boolean } = {}) {
  const calls: string[][] = [];
  const git: GitRunner = async (args) => {
    calls.push(args);
    if (args.includes('diff') && args.includes('--cached')) {
      if (opts.staged) throw new GitError('changes present', 1);
      return; // clean index
    }
    if (args.includes('rev-parse')) {
      return args.includes('origin/main') ? `${opts.mainSha ?? 'main000'}\n` : `${opts.headSha ?? 'head999'}\n`;
    }
    if (args.includes('push')) {
      if (opts.pushFails) throw new GitError('fatal: remote rejected', 1);
      return;
    }
    return; // add, commit
  };
  return { git, calls };
}

const sub = (call: string[]): string[] => call.filter((a) => a !== '-C' && !a.startsWith('safe.directory=') && a !== '-c' && a !== worktree.dir);

describe('wipRefName', () => {
  it('is the dedicated scratch namespace, never robot/<id>', () => {
    expect(wipRefName(898)).toBe('robot-wip/t898');
    // Crucially NOT under robot/, so it can never be a PR head or match robot-auto-merge.yml.
    expect(wipRefName(898).startsWith('robot/')).toBe(false);
  });
});

describe('pushWip', () => {
  it('commits staged WIP and force-pushes it to robot-wip/t<id>', async () => {
    const { git, calls } = fakeGit({ staged: true, headSha: 'abc1234' });
    const result = await pushWip(config, worktree, 42, git);
    expect(result).toEqual({ ref: 'robot-wip/t42', sha: 'abc1234' });
    // staged ⇒ a commit was made, then a force push to the WIP ref.
    expect(calls.some((c) => c.includes('commit'))).toBe(true);
    const push = calls.find((c) => c.includes('push'));
    expect(push && sub(push)).toEqual(['push', '--force', 'origin', 'HEAD:refs/heads/robot-wip/t42']);
    // stages everything via add -A (`.robot/` is gitignored, so it is never included).
    expect(calls.some((c) => c.includes('add') && c.includes('-A'))).toBe(true);
  });

  it('skips the push when nothing is staged and HEAD still equals main', async () => {
    const { git, calls } = fakeGit({ staged: false, headSha: 'same', mainSha: 'same' });
    const result = await pushWip(config, worktree, 42, git);
    expect(result).toBeNull();
    expect(calls.some((c) => c.includes('push'))).toBe(false);
    expect(calls.some((c) => c.includes('commit'))).toBe(false);
  });

  it('pushes already-committed work (HEAD diverged from main) even with a clean index', async () => {
    const { git, calls } = fakeGit({ staged: false, headSha: 'committed7', mainSha: 'main000' });
    const result = await pushWip(config, worktree, 42, git);
    expect(result).toEqual({ ref: 'robot-wip/t42', sha: 'committed7' });
    expect(calls.some((c) => c.includes('push'))).toBe(true);
    expect(calls.some((c) => c.includes('commit'))).toBe(false); // nothing to commit
  });

  it('returns null and never throws when the push fails (outcome must be unaffected)', async () => {
    const { git } = fakeGit({ staged: true, headSha: 'abc', pushFails: true });
    await expect(pushWip(config, worktree, 42, git)).resolves.toBeNull();
  });
});

describe('deleteWipRef', () => {
  it('deletes the remote ref', async () => {
    const { git, calls } = fakeGit();
    await deleteWipRef(config, 42, '/some/clone', git);
    const push = calls.find((c) => c.includes('push'));
    expect(push?.includes('--delete')).toBe(true);
    expect(push?.includes('refs/heads/robot-wip/t42')).toBe(true);
  });

  it('never throws when the ref does not exist / delete fails', async () => {
    const { git } = fakeGit({ pushFails: true });
    await expect(deleteWipRef(config, 42, '/some/clone', git)).resolves.toBeUndefined();
  });
});
