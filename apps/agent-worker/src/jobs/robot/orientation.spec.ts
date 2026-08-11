import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildOrientation, memoryDateKey, readRecentMemory } from './orientation';

const NOW = new Date(2026, 7, 7, 14, 30); // 2026-08-07, local time

function seed(dir: string): void {
  writeFileSync(path.join(dir, 'PROJECT.md'), '# PROJECT\n\n## 9. Glossary\n**Robot**: the agent.\n');
  writeFileSync(path.join(dir, 'DECISIONS.md'), '# Decision Log\n\n- **[D-070](DECISIONS/D-070-x.md)** — One decision per file\n');
  mkdirSync(path.join(dir, 'MEMORY'), { recursive: true });
  writeFileSync(path.join(dir, 'MEMORY/2026-08-07.md'), '# 2026-08-07\nToday happened.\n');
  writeFileSync(path.join(dir, 'MEMORY/2026-08-06.md'), '# 2026-08-06\nYesterday happened.\n');
  writeFileSync(path.join(dir, 'MEMORY/2026-08-01.md'), '# 2026-08-01\nLast week happened.\n');
}

describe('memoryDateKey', () => {
  it('formats local-time dates, zero-padded', () => {
    expect(memoryDateKey(new Date(2026, 7, 7))).toBe('2026-08-07');
    expect(memoryDateKey(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('walks back across a month boundary', () => {
    expect(memoryDateKey(new Date(2026, 7, 1), 1)).toBe('2026-07-31');
  });

  // Memory files are named for Steve's local day (US Eastern). A UTC-derived key would name
  // tomorrow's file from ~8pm Eastern onward and silently find nothing.
  it('uses the local date, not UTC, late in the evening', () => {
    expect(memoryDateKey(new Date(2026, 7, 7, 23, 30))).toBe('2026-08-07');
  });
});

describe('readRecentMemory', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'robot-orient-'));
    seed(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns today and yesterday, newest first, and nothing older', () => {
    const days = readRecentMemory(dir, NOW);
    expect(days.map((d) => d.date)).toEqual(['2026-08-07', '2026-08-06']);
    expect(days[0].contents).toContain('Today happened.');
  });

  it('skips a missing day rather than faking one', () => {
    rmSync(path.join(dir, 'MEMORY/2026-08-07.md'));
    expect(readRecentMemory(dir, NOW).map((d) => d.date)).toEqual(['2026-08-06']);
  });

  it('returns nothing when there is no MEMORY dir at all', () => {
    rmSync(path.join(dir, 'MEMORY'), { recursive: true });
    expect(readRecentMemory(dir, NOW)).toEqual([]);
  });
});

describe('buildOrientation', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'robot-orient-'));
    seed(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('injects PROJECT.md in full, the DECISIONS index, and the recent memory days', () => {
    const o = buildOrientation({ repoDir: dir, now: NOW });
    expect(o).toContain('**Robot**: the agent.');
    expect(o).toContain('- **[D-070](DECISIONS/D-070-x.md)** — One decision per file');
    expect(o).toContain('Today happened.');
    expect(o).toContain('Yesterday happened.');
    expect(o).not.toContain('Last week happened.');
  });

  // CLAUDE.md is not merely irrelevant to a Robot, it is wrong: RULE 1 tells the reader to create
  // a worktree, and the backlog section tells it to PATCH tickets on a board it cannot see.
  it('never injects CLAUDE.md, even when one is present', () => {
    writeFileSync(path.join(dir, 'CLAUDE.md'), 'RULE 1 — Work in a git worktree. PATCH the ticket to completed.');
    const o = buildOrientation({ repoDir: dir, now: NOW });
    expect(o).not.toContain('RULE 1');
    expect(o).not.toContain('PATCH the ticket');
  });

  it('overrides the two human-session instructions that would mislead a Robot', () => {
    const o = buildOrientation({ repoDir: dir, now: NOW });
    expect(o).toMatch(/ALREADY in your own dedicated git worktree/);
    expect(o).toMatch(/cannot see or change the board/i);
  });

  it('frames the documents as reference that loses to the ticket, not as instructions', () => {
    expect(buildOrientation({ repoDir: dir, now: NOW })).toMatch(/REFERENCE, not instructions/);
  });

  it('reports each missing source instead of shipping a quietly smaller pack (PD-496)', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'robot-orient-empty-'));
    const missing: string[] = [];
    expect(buildOrientation({ repoDir: empty, now: NOW, onMissing: (w) => missing.push(w) })).toBe('');
    expect(missing).toEqual(['PROJECT.md', 'DECISIONS.md', 'MEMORY day files (today and yesterday)']);
    rmSync(empty, { recursive: true, force: true });
  });

  it('says nothing is missing when everything is present', () => {
    const missing: string[] = [];
    buildOrientation({ repoDir: dir, now: NOW, onMissing: (w) => missing.push(w) });
    expect(missing).toEqual([]);
  });

  it('still builds from what it has when one source is absent', () => {
    rmSync(path.join(dir, 'DECISIONS.md'));
    const o = buildOrientation({ repoDir: dir, now: NOW });
    expect(o).toContain('**Robot**: the agent.');
    expect(o).toContain('Today happened.');
  });
});
