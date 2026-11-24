import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildIsCurrent, parseBuildInputs } from './heartbeat';
import { findRepoRoot } from './shared/decisions';

// PD-816 / D-116: the worker image publishes only on worker-affecting merges, so after a web-only
// merge BUILD_SHA trails main and the worker is still current. These pin the evidence behind
// "current" so the dashboard doesn't cry "behind main" after every merge, and never says
// "current" without evidence.

describe('parseBuildInputs', () => {
  it('drops comments and blank lines', () => {
    expect(parseBuildInputs('# hi\n\napps/agent-worker\n  packages/shared  \n# x\n')).toEqual([
      'apps/agent-worker',
      'packages/shared',
    ]);
  });

  it('the real list covers what the worker Dockerfile COPYs', () => {
    const root = findRepoRoot(__dirname);
    const inputs = parseBuildInputs(readFileSync(path.join(root, 'ops/agent-worker/build-inputs.txt'), 'utf8'));
    const dockerfile = readFileSync(path.join(root, 'ops/agent-worker/Dockerfile'), 'utf8');
    // Every repo-relative COPY source (not --from=build stage copies) must sit under a listed input.
    const sources = [...dockerfile.matchAll(/^COPY (?!--from)(.+) \S+$/gm)].flatMap((m) => m[1].trim().split(/\s+/));
    expect(sources.length).toBeGreaterThan(0);
    for (const src of sources) {
      const clean = src.replace(/\/$/, '');
      expect(
        inputs.some((i) => clean === i || clean.startsWith(`${i}/`)),
        `${src} is COPYed into the worker image but missing from build-inputs.txt`,
      ).toBe(true);
    }
  });
});

describe('buildIsCurrent', () => {
  let repo: string;
  let base: string;
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  const commit = (file: string, body: string) => {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), body);
    git('add', file);
    git('commit', '-q', '-m', file);
    return git('rev-parse', '--short', 'HEAD');
  };

  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'hb-'));
    git('init', '-q');
    commit('ops/agent-worker/build-inputs.txt', '# inputs\napps/agent-worker\n');
    base = commit('apps/agent-worker/a.ts', '1');
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('is true when only non-input paths changed since the build (a web-only merge)', () => {
    commit('apps/web/page.svelte', 'x');
    expect(buildIsCurrent(repo, base)).toBe(true);
  });

  it('is false once a build input changes', () => {
    commit('apps/agent-worker/a.ts', '2');
    expect(buildIsCurrent(repo, base)).toBe(false);
  });

  it('is null without a build sha, or for a sha the checkout does not have', () => {
    expect(buildIsCurrent(repo, null)).toBeNull();
    expect(buildIsCurrent(repo, 'deadbee')).toBeNull();
  });

  it('is null when the checkout is missing', () => {
    expect(buildIsCurrent(path.join(repo, 'nope'), base)).toBeNull();
  });
});
