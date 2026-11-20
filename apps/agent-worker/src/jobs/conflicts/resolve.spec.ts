import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../shared/config';
import { defaultExec, resolveConflicts, type Exec } from './resolve';

/**
 * The resolver against REAL git: a bare "origin" with a main and a PR branch that conflict. Only npm
 * is faked (no install or verify runs here); every git step, the diff3 markers and the push are real.
 */

const g = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();

const SENSITIVE = '.github/**\n**/package.json\n';

let root: string;
let origin: string;
let work: string;

function write(rel: string, text: string) {
  mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
  writeFileSync(path.join(work, rel), text);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'conflict-'));
  origin = path.join(root, 'origin.git');
  work = path.join(root, 'work');
  g(root, 'init', '--bare', origin);
  g(root, 'clone', origin, work);
  write('.github/sensitive-paths.txt', SENSITIVE);
  write('index.ts', "export { a } from './a';\n");
  write('app.ts', 'const x = 1;\n');
  g(work, 'add', '.');
  g(work, 'commit', '-m', 'base');
  g(work, 'push', 'origin', 'HEAD:main');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function branchAndMain(onBranch: () => void, onMain: () => void): string {
  g(work, 'checkout', '-b', 'robot/t1');
  onBranch();
  g(work, 'commit', '-am', 'branch');
  g(work, 'push', 'origin', 'robot/t1');
  const head = g(work, 'rev-parse', 'HEAD');
  g(work, 'checkout', 'main');
  onMain();
  g(work, 'commit', '-am', 'main');
  g(work, 'push', 'origin', 'main');
  return head;
}

function harness(npmCode = 0) {
  const config = loadConfig({ ROBOT_GITHUB_TOKEN: 'ghp_test', DATA_DIR: path.join(root, 'data') });
  const real = defaultExec(config);
  const npmCalls: string[][] = [];
  const exec: Exec = async (cmd, args, opts) => {
    if (cmd === 'npm') {
      npmCalls.push(args);
      return { code: npmCode, stdout: '', stderr: npmCode ? 'boom' : '' };
    }
    return real(cmd, args, opts);
  };
  return { config, exec, npmCalls };
}

describe('resolveConflicts against real git (PD-774)', () => {
  it('unions an append-only conflict, verifies, and pushes a merge commit', async () => {
    const head = branchAndMain(
      () => write('index.ts', "export { a } from './a';\nexport { fromBranch } from './b';\n"),
      () => write('index.ts', "export { a } from './a';\nexport { fromMain } from './m';\n"),
    );
    const { config, exec, npmCalls } = harness();
    const out = await resolveConflicts(config, { repo: 'x/y', prNumber: 7, branch: 'robot/t1', headSha: head }, exec, origin);
    expect(out.kind).toBe('resolved');
    expect(npmCalls).toEqual([['ci'], ['run', 'verify']]);
    const pushed = g(root, '--git-dir', origin, 'show', 'robot/t1:index.ts');
    expect(pushed).toBe("export { a } from './a';\nexport { fromMain } from './m';\nexport { fromBranch } from './b';");
    // A merge commit on top of the old head: history kept, fast-forward push.
    expect(g(root, '--git-dir', origin, 'rev-parse', 'robot/t1^1')).toBe(head);
  });

  it('refuses and pushes nothing when both sides edited the same line', async () => {
    const head = branchAndMain(
      () => write('app.ts', 'const x = 2;\n'),
      () => write('app.ts', 'const x = 3;\n'),
    );
    const { config, exec, npmCalls } = harness();
    const out = await resolveConflicts(config, { repo: 'x/y', prNumber: 7, branch: 'robot/t1', headSha: head }, exec, origin);
    expect(out).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/app\.ts: both sides changed the same lines/) });
    expect(npmCalls).toEqual([]);
    expect(g(root, '--git-dir', origin, 'rev-parse', 'robot/t1')).toBe(head);
  });

  it('refuses a sensitive path even when it is append-only', async () => {
    const head = branchAndMain(
      () => write('.github/sensitive-paths.txt', `${SENSITIVE}from-branch\n`),
      () => write('.github/sensitive-paths.txt', `${SENSITIVE}from-main\n`),
    );
    const { config, exec } = harness();
    const out = await resolveConflicts(config, { repo: 'x/y', prNumber: 7, branch: 'robot/t1', headSha: head }, exec, origin);
    expect(out).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/sensitive/) });
  });

  it('does not push when verify fails', async () => {
    const head = branchAndMain(
      () => write('index.ts', "export { a } from './a';\nexport { b } from './b';\n"),
      () => write('index.ts', "export { a } from './a';\nexport { m } from './m';\n"),
    );
    const { config, exec } = harness(1);
    const out = await resolveConflicts(config, { repo: 'x/y', prNumber: 7, branch: 'robot/t1', headSha: head }, exec, origin);
    expect(out.kind).toBe('verify-failed');
    expect(g(root, '--git-dir', origin, 'rev-parse', 'robot/t1')).toBe(head);
  });

  it('reports a race when the branch head is not the one the decision was made on', async () => {
    branchAndMain(
      () => write('index.ts', "export { a } from './a';\nexport { b } from './b';\n"),
      () => write('index.ts', "export { a } from './a';\nexport { m } from './m';\n"),
    );
    const { config, exec } = harness();
    const out = await resolveConflicts(config, { repo: 'x/y', prNumber: 7, branch: 'robot/t1', headSha: 'deadbeef' }, exec, origin);
    expect(out.kind).toBe('raced');
  });
});
