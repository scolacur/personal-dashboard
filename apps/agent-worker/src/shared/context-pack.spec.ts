import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GLOSSARY_HEADING, extractSection, extractSectionMatching, buildContextPack } from './context-pack';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

describe('extractSection', () => {
  const md = ['# Title', '', '## 1. A', 'aaa', '', '## 8. Glossary', 'g1', 'g2', '', '## 9. Next', 'zzz'].join('\n');

  it('pulls a section up to the next ## heading', () => {
    expect(extractSection(md, '## 8. Glossary')).toBe('## 8. Glossary\ng1\ng2');
  });

  it('returns empty when the heading is absent', () => {
    expect(extractSection(md, '## 42. Missing')).toBe('');
  });
});

describe('extractSectionMatching', () => {
  const withNumber = ['# T', '## 9. Glossary / Domain Language', 'g1', '## 10. Next', 'z'].join('\n');
  const renumbered = ['# T', '## 12. Glossary / Domain Language', 'g1', '## 13. Next', 'z'].join('\n');
  const unnumbered = ['# T', '## Glossary', 'g1', '## Next', 'z'].join('\n');

  // The whole point of this function: the ordinal is not part of the identity. PD-496 was two
  // months of no glossary because a lookup was pinned to "8" and the section became 9.
  it('finds the section regardless of its section number', () => {
    for (const md of [withNumber, renumbered, unnumbered]) {
      expect(extractSectionMatching(md, GLOSSARY_HEADING)).toContain('g1');
    }
  });

  it('only matches ## headings, not body text that happens to say the word', () => {
    const md = ['# T', '## 1. Intro', 'see the glossary below', '## 2. Real Glossary', 'g1'].join('\n');
    expect(extractSectionMatching(md, GLOSSARY_HEADING)).toBe('## 2. Real Glossary\ng1');
  });

  it('returns empty when no heading matches', () => {
    expect(extractSectionMatching(['# T', '## 1. Intro', 'x'].join('\n'), GLOSSARY_HEADING)).toBe('');
  });
});

describe('buildContextPack', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'agent-worker-ctx-'));
    writeFileSync(
      path.join(dir, 'PROJECT.md'),
      ['# PROJECT', '## 7. Other', 'x', '## 8. Glossary', '**Refine**: the session.', '## 9. End', 'y'].join('\n'),
    );
    mkdirSync(path.join(dir, 'apps/server/src/widgets/music-tracker'), { recursive: true });
    mkdirSync(path.join(dir, 'apps/server/src/widgets/task-monitor'), { recursive: true });
    mkdirSync(path.join(dir, 'apps/web/src/routes/widgets/pomodoro'), { recursive: true });
    mkdirSync(path.join(dir, 'packages/shared/src'), { recursive: true });
    writeFileSync(path.join(dir, 'packages/shared/src/index.ts'), '');
    writeFileSync(path.join(dir, 'packages/shared/src/task-monitor.ts'), '');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('includes the glossary and a de-duplicated building-block index', () => {
    const pack = buildContextPack(dir);
    expect(pack).toContain('**Refine**: the session.');
    expect(pack).toContain('music-tracker, task-monitor'); // sorted server widgets
    expect(pack).toContain('pomodoro'); // web widget route
    expect(pack).toContain('task-monitor.ts'); // shared module, index.ts excluded
    expect(pack).not.toContain('index.ts');
  });

  it('degrades gracefully when nothing is present', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'agent-worker-empty-'));
    expect(buildContextPack(empty)).toBe('## Existing building blocks (reuse before adding new)');
    rmSync(empty, { recursive: true, force: true });
  });

  it('reports a missing glossary instead of quietly shipping a smaller pack', () => {
    writeFileSync(path.join(dir, 'PROJECT.md'), ['# PROJECT', '## 7. Other', 'x'].join('\n'));
    const missing: string[] = [];
    const pack = buildContextPack(dir, (what) => missing.push(what));
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatch(/Glossary/);
    expect(pack).toContain('## Existing building blocks'); // still usable — a warning, not a failure
  });

  it('reports a missing PROJECT.md', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'agent-worker-empty-'));
    const missing: string[] = [];
    buildContextPack(empty, (what) => missing.push(what));
    expect(missing[0]).toMatch(/PROJECT\.md not found/);
    rmSync(empty, { recursive: true, force: true });
  });

  it('says nothing when everything it expects is present', () => {
    const missing: string[] = [];
    buildContextPack(dir, (what) => missing.push(what));
    expect(missing).toEqual([]);
  });
});

// PD-496 survived two months because every test above builds its own fixture containing the
// heading it then looks for — the test and the bug agreed with each other. These run against the
// REAL repo, which is the only thing that can catch a lookup that no longer matches the document.
describe('against this repo', () => {
  it("finds PROJECT.md's glossary as it is actually written today", () => {
    const projectMd = readFileSync(path.join(REPO_ROOT, 'PROJECT.md'), 'utf8');
    const glossary = extractSectionMatching(projectMd, GLOSSARY_HEADING);
    expect(glossary).not.toBe('');
    expect(glossary.length).toBeGreaterThan(200); // a real glossary, not just the heading line
  });

  it('builds a pack for this repo with the glossary in it and nothing reported missing', () => {
    const missing: string[] = [];
    const pack = buildContextPack(REPO_ROOT, (what) => missing.push(what));
    expect(missing).toEqual([]);
    expect(pack).toMatch(GLOSSARY_HEADING);
    expect(pack).toContain('## Existing building blocks');
  });

  it('survives the renumbering that broke it — the ordinal is not what is matched', () => {
    const projectMd = readFileSync(path.join(REPO_ROOT, 'PROJECT.md'), 'utf8');
    const shifted = projectMd.replace(/^## \d+\. Glossary/m, '## 42. Glossary');
    expect(shifted).not.toBe(projectMd); // guard: the substitution actually applied
    expect(extractSectionMatching(shifted, GLOSSARY_HEADING)).not.toBe('');
  });
});
