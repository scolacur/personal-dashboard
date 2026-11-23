import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { loadConfig, type AgentWorkerConfig } from '../../shared/config';
import { GitError, makeGitRunner, type GitRunner, type Worktree } from './workspace';
import { deleteWipRef, pushWip, restoreWip, wipRefName } from './wip';

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

describe('pushWip against real git: the reused branch never keeps the WIP (PD-781)', () => {
  const g = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();

  let root: string;
  let origin: string;
  let clone: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'wip-'));
    origin = path.join(root, 'origin.git');
    clone = path.join(root, 'robot-t42');
    g(root, 'init', '--bare', origin);
    g(root, 'clone', origin, clone);
    g(clone, 'config', 'user.name', 't');
    g(clone, 'config', 'user.email', 't@t');
    writeFileSync(path.join(clone, 'a.ts'), 'base\n');
    g(clone, 'add', '.');
    g(clone, 'commit', '-m', 'base');
    g(clone, 'push', 'origin', 'HEAD:main');
    g(clone, 'fetch', 'origin');
    g(clone, 'checkout', '-b', 'robot/t42');
    // A commit the Robot made itself: PD-719 keeps these across reuse.
    writeFileSync(path.join(clone, 'a.ts'), 'robot commit\n');
    g(clone, 'commit', '-am', 'robot work');
    // Then the run ends without a hand-off, leaving uncommitted work.
    writeFileSync(path.join(clone, 'a.ts'), 'half-finished\n');
    writeFileSync(path.join(clone, 'new.ts'), 'untracked\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('pushes the WIP to robot-wip/t42, then leaves robot/t42 on the Robot’s own last commit', async () => {
    const robotCommit = g(clone, 'rev-parse', 'HEAD');
    const out = await pushWip(loadConfig({}), { dir: clone, branch: 'robot/t42' }, 42, makeGitRunner(loadConfig({}), ''));

    expect(out?.ref).toBe('robot-wip/t42');
    // The work is preserved on the WIP ref…
    expect(g(root, '--git-dir', origin, 'show', 'robot-wip/t42:a.ts')).toBe('half-finished');
    expect(g(root, '--git-dir', origin, 'show', 'robot-wip/t42:new.ts')).toBe('untracked');
    // …and the live branch is back on the Robot's own commit, the work uncommitted again.
    expect(g(clone, 'rev-parse', 'HEAD')).toBe(robotCommit);
    expect(g(clone, 'status', '--porcelain')).toContain('a.ts');

    // What reuse does on the next dispatch (ensureWorktree): it starts pristine, not from the WIP.
    g(clone, 'reset', '--hard', 'HEAD');
    g(clone, 'clean', '-fd');
    expect(readFileSync(path.join(clone, 'a.ts'), 'utf8')).toBe('robot commit\n');
  });

  it('undoes the WIP commit even when the push fails', async () => {
    const robotCommit = g(clone, 'rev-parse', 'HEAD');
    g(clone, 'remote', 'set-url', 'origin', path.join(root, 'missing.git'));
    const out = await pushWip(loadConfig({}), { dir: clone, branch: 'robot/t42' }, 42, makeGitRunner(loadConfig({}), ''));
    expect(out).toBeNull();
    expect(g(clone, 'rev-parse', 'HEAD')).toBe(robotCommit);
  });
});

// D-094/PD-737: Continue restores the saved work — rebased onto current main where it applies.
describe('restoreWip against real git (PD-737)', () => {
  const g = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();
  const noChown = async () => {};
  const cfg = loadConfig({});
  const runner = () => makeGitRunner(cfg, '');

  let root: string;
  let origin: string;
  let author: string;
  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'restore-'));
    origin = path.join(root, 'origin.git');
    author = path.join(root, 'author');
    g(root, 'init', '--bare', origin);
    g(root, 'clone', origin, author);
    g(author, 'config', 'user.name', 't');
    g(author, 'config', 'user.email', 't@t');
    writeFileSync(path.join(author, 'a.ts'), 'base\n');
    g(author, 'add', '.');
    g(author, 'commit', '-m', 'base');
    g(author, 'push', 'origin', 'HEAD:main');
    // A checkpointed run: it left uncommitted work, which pushWip saved to robot-wip/t42.
    g(author, 'checkout', '-b', 'robot/t42');
    writeFileSync(path.join(author, 'a.ts'), 'half-finished\n');
    writeFileSync(path.join(author, 'new.ts'), 'untracked\n');
    await pushWip(cfg, { dir: author, branch: 'robot/t42' }, 42, runner());
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Advance main with one file, as other PRs merging would. */
  function advanceMain(file: string, content: string): void {
    const other = path.join(root, `other-${file}`);
    g(root, 'clone', origin, other);
    writeFileSync(path.join(other, file), content);
    g(other, 'add', '.');
    g(other, 'commit', '-m', `main: ${file}`);
    g(other, 'push', 'origin', 'HEAD:main');
  }
  /** The (shallow) clone ensureWorktree would prepare for the Continue run: fresh from main, on the branch. */
  function freshClone(): string {
    const dir = path.join(root, 'robot-t42');
    // Shallow, like ensureWorktree's real clone — the rebase must find its base via restoreWip's deepen.
    g(root, 'clone', '--depth', '1', `file://${origin}`, dir);
    g(dir, 'config', 'user.name', 't');
    g(dir, 'config', 'user.email', 't@t');
    g(dir, 'checkout', '-B', 'robot/t42');
    return dir;
  }

  it('restores the WIP as uncommitted changes, rebased onto a main that moved on', async () => {
    advanceMain('b.ts', 'from main\n');
    const dir = freshClone();
    const out = await restoreWip(cfg, { dir, branch: 'robot/t42' }, 42, runner(), noChown);
    expect(out).toEqual({ restored: true, rebased: true });
    expect(readFileSync(path.join(dir, 'a.ts'), 'utf8')).toBe('half-finished\n');
    expect(readFileSync(path.join(dir, 'new.ts'), 'utf8')).toBe('untracked\n');
    expect(readFileSync(path.join(dir, 'b.ts'), 'utf8')).toBe('from main\n'); // on current main
    expect(g(dir, 'log', '-1', '--format=%s')).toBe('main: b.ts'); // the WIP commit is undone…
    expect(g(dir, 'status', '--porcelain')).toContain('a.ts'); // …so the work is uncommitted
  });

  it('keeps the WIP as-is when the rebase conflicts', async () => {
    advanceMain('a.ts', 'main changed the same line\n');
    const dir = freshClone();
    const out = await restoreWip(cfg, { dir, branch: 'robot/t42' }, 42, runner(), noChown);
    expect(out).toEqual({ restored: true, rebased: false });
    expect(readFileSync(path.join(dir, 'a.ts'), 'utf8')).toBe('half-finished\n');
    expect(g(dir, 'status', '--porcelain')).not.toMatch(/^(UU|AA) /m); // no rebase left half-done
  });

  it('reports not-restored when there is no WIP ref, leaving the tree as prepared', async () => {
    const dir = freshClone();
    const out = await restoreWip(cfg, { dir, branch: 'robot/t42' }, 99, runner(), noChown);
    expect(out).toEqual({ restored: false, rebased: false });
    expect(readFileSync(path.join(dir, 'a.ts'), 'utf8')).toBe('base\n');
  });
});
