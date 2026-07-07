import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractSection, buildContextPack } from './context-pack';

describe('extractSection', () => {
  const md = ['# Title', '', '## 1. A', 'aaa', '', '## 8. Glossary', 'g1', 'g2', '', '## 9. Next', 'zzz'].join('\n');

  it('pulls a section up to the next ## heading', () => {
    expect(extractSection(md, '## 8. Glossary')).toBe('## 8. Glossary\ng1\ng2');
  });

  it('returns empty when the heading is absent', () => {
    expect(extractSection(md, '## 42. Missing')).toBe('');
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
});
