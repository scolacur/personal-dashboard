import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Decision, ProvisionalDecision } from '../../shared/decisions';
import { loadDecisions, loadProvisionalDecisions } from '../../shared/decisions';
import { applyAssignments, rewritableFiles, SKIP_DIRS } from './apply';
import { assignNumbers } from './numbering';

function prov(ticketNum: number, title: string, letter = 'a'): ProvisionalDecision {
  const id = `D-TMP-PD${ticketNum}${letter}`;
  return { id, ticketPrefix: 'PD', ticketNum, letter, title, file: `DECISIONS/incoming/${id}.md` };
}

function numbered(num: number): Decision {
  const id = `D-${String(num).padStart(3, '0')}`;
  return { id, num, slug: 'x', title: 't', file: `DECISIONS/${id}-x.md` };
}

/** A miniature repo: a numbered decision, two provisional ones, and prose citing them. */
function makeTree(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'numbering-'));
  mkdirSync(path.join(root, 'DECISIONS/incoming'), { recursive: true });
  mkdirSync(path.join(root, 'apps/server/src'), { recursive: true });
  mkdirSync(path.join(root, 'node_modules/pkg'), { recursive: true });
  mkdirSync(path.join(root, '.claude/worktrees/other-session'), { recursive: true });

  writeFileSync(path.join(root, 'DECISIONS/D-079-x.md'), '# D-079: An existing decision\n\nbody\n');
  writeFileSync(
    path.join(root, 'DECISIONS/incoming/D-TMP-PD383a.md'),
    '# D-TMP-PD383a: The Epic is the unit of dispatch\n\nSupersedes nothing. See D-TMP-PD513a.\n',
  );
  writeFileSync(
    path.join(root, 'DECISIONS/incoming/D-TMP-PD513a.md'),
    '# D-TMP-PD513a: A session writes to the memory inbox\n\nSee D-079 and D-TMP-PD383a.\n',
  );
  writeFileSync(path.join(root, 'PROJECT.md'), 'Priority is an Epic property (D-TMP-PD383a).\n');
  writeFileSync(path.join(root, 'apps/server/src/store.ts'), '// D-TMP-PD383a: cascade on write\nexport const x = 1;\n');
  writeFileSync(path.join(root, 'README.md'), 'No citations here.\n');
  // Traps: neither of these may be touched.
  writeFileSync(path.join(root, 'node_modules/pkg/index.js'), '// D-TMP-PD383a\n');
  writeFileSync(path.join(root, '.claude/worktrees/other-session/notes.md'), 'D-TMP-PD383a on another branch\n');
  return root;
}

describe('rewritableFiles', () => {
  it('skips node_modules and other sessions’ worktrees', () => {
    const files = rewritableFiles(makeTree());
    expect(files).toContain('PROJECT.md');
    expect(files).toContain(path.join('apps', 'server', 'src', 'store.ts'));
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    expect(files.some((f) => f.includes('worktrees'))).toBe(false);
  });

  it('names the worktrees skip explicitly — this repo nests worktrees inside the checkout', () => {
    // If this ever stops being true, the cycle would rewrite files on every concurrent session's
    // branch. Asserting the constant, not just the behaviour, so removing it fails loudly.
    expect(SKIP_DIRS.has('worktrees')).toBe(true);
    expect(SKIP_DIRS.has('node_modules')).toBe(true);
    expect(SKIP_DIRS.has('.git')).toBe(true);
  });
});

describe('applyAssignments', () => {
  let root: string;
  beforeEach(() => {
    root = makeTree();
  });

  const assignments = () =>
    assignNumbers([numbered(79)], [prov(383, 'The Epic is the unit of dispatch'), prov(513, 'A session writes to the memory inbox')]);

  it('moves each decision out of the inbox to its numbered path', () => {
    const result = applyAssignments(root, assignments());
    expect(existsSync(path.join(root, 'DECISIONS/incoming/D-TMP-PD383a.md'))).toBe(false);
    expect(existsSync(path.join(root, 'DECISIONS/D-080-the-epic-is-the-unit-of-dispatch.md'))).toBe(true);
    expect(result.moved).toHaveLength(2);
  });

  it('rewrites the heading so it agrees with the new filename', () => {
    applyAssignments(root, assignments());
    const body = readFileSync(path.join(root, 'DECISIONS/D-080-the-epic-is-the-unit-of-dispatch.md'), 'utf8');
    expect(body.split('\n')[0]).toBe('# D-080: The Epic is the unit of dispatch');
  });

  it('rewrites citations in prose and in source alike', () => {
    applyAssignments(root, assignments());
    expect(readFileSync(path.join(root, 'PROJECT.md'), 'utf8')).toBe('Priority is an Epic property (D-080).\n');
    expect(readFileSync(path.join(root, 'apps/server/src/store.ts'), 'utf8')).toContain('// D-080: cascade on write');
  });

  it('rewrites decisions that cite each other, including the one being renumbered', () => {
    // This is why the move happens before the sweep: the moved file is picked up at its NEW path by
    // the same pass that fixes everyone else, with no special case.
    applyAssignments(root, assignments());
    expect(readFileSync(path.join(root, 'DECISIONS/D-080-the-epic-is-the-unit-of-dispatch.md'), 'utf8')).toContain(
      'See D-081.',
    );
    expect(readFileSync(path.join(root, 'DECISIONS/D-081-a-session-writes-to-the-memory-inbox.md'), 'utf8')).toContain(
      'See D-079 and D-080.',
    );
  });

  it('leaves node_modules and other sessions’ worktrees untouched', () => {
    applyAssignments(root, assignments());
    expect(readFileSync(path.join(root, 'node_modules/pkg/index.js'), 'utf8')).toContain('D-TMP-PD383a');
    expect(readFileSync(path.join(root, '.claude/worktrees/other-session/notes.md'), 'utf8')).toContain('D-TMP-PD383a');
  });

  it('reports only the files it actually changed', () => {
    const result = applyAssignments(root, assignments());
    expect(result.rewritten).toContain('PROJECT.md');
    expect(result.rewritten).not.toContain('README.md');
  });

  it('reports a dangling citation instead of guessing at it', () => {
    writeFileSync(path.join(root, 'PROJECT.md'), 'cites D-TMP-PD999z which is not in the inbox\n');
    const result = applyAssignments(root, assignments());
    expect(result.dangling).toEqual(['D-TMP-PD999z']);
    expect(readFileSync(path.join(root, 'PROJECT.md'), 'utf8')).toContain('D-TMP-PD999z');
  });

  it('leaves the log loadable, which is the real contract', () => {
    // loadDecisions throws on a heading/filename mismatch or a duplicate id. Running it over the
    // result is a stronger assertion than any string check: it is the same function CI runs.
    writeFileSync(path.join(root, 'DECISIONS.md'), 'placeholder index\n');
    applyAssignments(root, assignments());
    const decisions = loadDecisions(root);
    expect(decisions.map((d) => d.id)).toEqual(['D-081', 'D-080', 'D-079']);
    expect(loadProvisionalDecisions(root)).toEqual([]);
  });

  it('is a no-op on an empty inbox', () => {
    const result = applyAssignments(root, []);
    expect(result.moved).toEqual([]);
    expect(result.rewritten).toEqual([]);
  });
});
