import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { findRepoRoot } from '../../shared/decisions';
import { classifyConflict, globToRegExp, parseSensitivePaths, unionAppendOnly, unmergedFromStatus } from './classify';

const SENSITIVE = parseSensitivePaths(readFileSync(path.join(findRepoRoot(), '.github/sensitive-paths.txt'), 'utf8'));

// A real shape: #429 (Decisions inbox, PD-746) and #430 (Refine auto-start, PD-747) both appended
// exports to packages/shared/src/index.ts, which is the conflict that was rebased by hand on 2026-11-19.
const APPEND_BOTH = [
  "export { refineSessionEnd } from './task-monitor';",
  '<<<<<<< HEAD',
  "export { REFINE_AUTOSTART_STATUS_KEY } from './refine-questions';",
  '||||||| merged common ancestors',
  '=======',
  "export { listAwaitingRefine } from './refine-questions';",
  '>>>>>>> origin/main',
  '',
].join('\n');

describe('globToRegExp', () => {
  it('follows git pathspec glob semantics for the sensitive-path list', () => {
    expect(globToRegExp('**/package.json').test('package.json')).toBe(true);
    expect(globToRegExp('**/package.json').test('apps/web/package.json')).toBe(true);
    expect(globToRegExp('.github/**').test('.github/workflows/ci.yml')).toBe(true);
    expect(globToRegExp('**/*cors*').test('apps/server/src/cors.ts')).toBe(true);
    expect(globToRegExp('apps/server/src/migrate.ts').test('apps/server/src/migrate.tsx')).toBe(false);
    expect(globToRegExp('ops/*').test('ops/a/b')).toBe(false);
  });
});

describe('unionAppendOnly', () => {
  it('keeps both sides of an append-only hunk, main first', () => {
    expect(unionAppendOnly(APPEND_BOTH)).toBe(
      [
        "export { refineSessionEnd } from './task-monitor';",
        "export { listAwaitingRefine } from './refine-questions';",
        "export { REFINE_AUTOSTART_STATUS_KEY } from './refine-questions';",
        '',
      ].join('\n'),
    );
  });

  it('refuses when the base section is not empty (someone changed existing lines)', () => {
    const edited = ['<<<<<<< HEAD', 'a = 2', '||||||| base', 'a = 1', '=======', 'a = 3', '>>>>>>> origin/main'].join('\n');
    expect(unionAppendOnly(edited)).toBeNull();
  });

  it('refuses a deletion on one side, a non-diff3 hunk, and malformed markers', () => {
    expect(unionAppendOnly(['<<<<<<< HEAD', '||||||| base', '=======', 'x', '>>>>>>> m'].join('\n'))).toBeNull();
    expect(unionAppendOnly(['<<<<<<< HEAD', 'x', '=======', 'y', '>>>>>>> m'].join('\n'))).toBeNull();
    expect(unionAppendOnly(['<<<<<<< HEAD', 'x', '||||||| base', '=======', 'y'].join('\n'))).toBeNull();
    expect(unionAppendOnly('no markers at all\n')).toBeNull();
  });

  it('resolves several hunks in one file, and refuses the file if any one is not append-only', () => {
    const two = `${APPEND_BOTH}middle\n${APPEND_BOTH}`;
    expect(unionAppendOnly(two)).not.toBeNull();
    const bad = `${APPEND_BOTH}${['<<<<<<< HEAD', 'a', '||||||| b', 'old', '=======', 'c', '>>>>>>> m'].join('\n')}`;
    expect(unionAppendOnly(bad)).toBeNull();
  });
});

describe('classifyConflict', () => {
  it('regenerates the decision index and its seed module', () => {
    expect(classifyConflict('DECISIONS.md', 'UU', 'x', SENSITIVE).kind).toBe('regenerate');
  });

  it('unions an append-only export list', () => {
    const v = classifyConflict('packages/shared/src/index.ts', 'UU', APPEND_BOTH, SENSITIVE);
    expect(v.kind).toBe('union');
  });

  it('refuses sensitive paths even when the shape qualifies', () => {
    for (const p of ['package-lock.json', 'apps/web/package.json', '.github/workflows/ci.yml', 'apps/server/src/widgets/task-monitor/schema.ts']) {
      expect(classifyConflict(p, 'UU', APPEND_BOTH, SENSITIVE)).toMatchObject({ kind: 'refuse', reason: expect.stringMatching(/sensitive/) });
    }
  });

  it('refuses delete/add shapes and edits to the same lines', () => {
    expect(classifyConflict('apps/web/src/a.ts', 'UD', null, SENSITIVE).kind).toBe('refuse');
    expect(classifyConflict('apps/web/src/a.ts', 'AA', APPEND_BOTH, SENSITIVE).kind).toBe('refuse');
    const edited = ['<<<<<<< HEAD', 'a = 2', '||||||| base', 'a = 1', '=======', 'a = 3', '>>>>>>> origin/main'].join('\n');
    expect(classifyConflict('apps/web/src/a.ts', 'UU', edited, SENSITIVE)).toMatchObject({ kind: 'refuse', reason: expect.stringMatching(/same lines/) });
  });
});

describe('unmergedFromStatus', () => {
  it('picks the unmerged entries out of porcelain v1 output', () => {
    const out = ['UU packages/shared/src/index.ts', 'M  apps/web/x.ts', 'UD old.ts', '?? new.ts', 'AA "with space.ts"'].join('\n');
    expect(unmergedFromStatus(out)).toEqual([
      { status: 'UU', path: 'packages/shared/src/index.ts' },
      { status: 'UD', path: 'old.ts' },
      { status: 'AA', path: 'with space.ts' },
    ]);
  });
});
