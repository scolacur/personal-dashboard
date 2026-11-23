import { describe, it, expect } from 'vitest';
import {
  findFixCommits,
  isCodePath,
  isNoiseLine,
  parseBlamePorcelain,
  parseLog,
  parseOldHunks,
  prNumberFromUrl,
  prNumberOf,
  ticketIdsIn,
  topSuspect,
} from './analyze';

describe('parseLog / prNumberOf / ticketIdsIn', () => {
  it('reads sha, time and subject; finds the squash PR and ticket ids', () => {
    const [c] = parseLog(
      'abc\x1f1700000000\x1ffix(robot): reclaim orphans (PD-784, D-104) (#461)\n',
    );
    expect(c).toEqual({
      sha: 'abc',
      committedAt: 1700000000000,
      subject: 'fix(robot): reclaim orphans (PD-784, D-104) (#461)',
    });
    expect(prNumberOf(c.subject)).toBe(461);
    expect(prNumberOf('no pr here')).toBeNull();
    expect(ticketIdsIn(c.subject)).toEqual(['PD-784']); // D-104 is a decision, not a ticket
    expect(prNumberFromUrl('https://github.com/o/r/pull/77')).toBe(77);
    expect(prNumberFromUrl(null)).toBeNull();
  });
});

describe('isCodePath', () => {
  it('keeps source, drops tests, memory, decisions and prose', () => {
    expect(isCodePath('apps/agent-worker/src/jobs/robot/stall.ts')).toBe(true);
    expect(isCodePath('apps/web/src/lib/A.svelte')).toBe(true);
    expect(isCodePath('.github/workflows/ci.yml')).toBe(true);
    expect(isCodePath('apps/agent-worker/src/jobs/robot/stall.spec.ts')).toBe(false);
    expect(isCodePath('MEMORY/runs/x.md')).toBe(false);
    expect(isCodePath('DECISIONS.md')).toBe(false);
    expect(isCodePath('README.md')).toBe(false);
  });
});

describe('findFixCommits', () => {
  const commits = parseLog(
    [
      'a\x1f3\x1ffix: thing (PD-784) (#461)',
      'b\x1f2\x1f[Robot] something (#300)',
      'c\x1f1\x1fchore: unrelated PD-7840 (#10)',
    ].join('\n'),
  );
  it('links by the display id in the subject, or by a Robot run PR', () => {
    expect(
      findFixCommits({ displayId: 'PD-784', robotPrs: new Set([300]) }, commits).map((c) => c.sha),
    ).toEqual(['a', 'b']);
  });
  it('matches the id as a whole word only', () => {
    expect(
      findFixCommits({ displayId: 'PD-784', robotPrs: new Set() }, commits).map((c) => c.sha),
    ).toEqual(['a']);
  });
});

describe('parseOldHunks', () => {
  it('returns changed/deleted old ranges and skips pure additions', () => {
    const diff = '@@ -10,3 +10,4 @@ x\n@@ -20 +21 @@\n@@ -30,0 +32,5 @@\n';
    expect(parseOldHunks(diff)).toEqual([
      { start: 10, count: 3 },
      { start: 20, count: 1 },
    ]);
  });
});

describe('parseBlamePorcelain / isNoiseLine', () => {
  const sha1 = 'a'.repeat(40);
  const sha2 = 'b'.repeat(40);
  const out = [
    `${sha1} 1 1 2`,
    'author X',
    'summary s',
    '\tconst x = 1;',
    `${sha1} 2 2`,
    'author X',
    '\t// a comment',
    `${sha2} 9 3 1`,
    'author Y',
    'boundary',
    '\t}',
  ].join('\n');
  it('pairs each content line with its commit', () => {
    expect(parseBlamePorcelain(out)).toEqual([
      { sha: sha1, content: 'const x = 1;' },
      { sha: sha1, content: '// a comment' },
      { sha: sha2, content: '}' },
    ]);
  });
  it('treats blanks, lone punctuation and comments as noise', () => {
    for (const t of [
      '',
      '   ',
      '}',
      '});',
      '// x',
      '/* x',
      ' * x',
      '# yaml comment',
      '<!-- x -->',
    ]) {
      expect(isNoiseLine(t)).toBe(true);
    }
    for (const t of ['const x = 1;', 'return a > b;', '#!/bin/sh'])
      expect(isNoiseLine(t)).toBe(false);
  });
});

describe('topSuspect', () => {
  it('credits the most blamed lines; a tie goes to the most recent commit', () => {
    expect(topSuspect([])).toBeNull();
    expect(
      topSuspect([
        { sha: 'x', lines: 2, committedAt: 9 },
        { sha: 'y', lines: 5, committedAt: 1 },
      ])!.sha,
    ).toBe('y');
    expect(
      topSuspect([
        { sha: 'x', lines: 5, committedAt: 1 },
        { sha: 'y', lines: 5, committedAt: 9 },
      ])!.sha,
    ).toBe('y');
  });
});
