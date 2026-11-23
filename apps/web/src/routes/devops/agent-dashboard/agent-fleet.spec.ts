import { describe, it, expect } from 'vitest';
import type { ActiveAgent } from '@dashboard/shared';
import {
  DEFAULT_BOT_COLOR,
  agentKey,
  botColor,
  formatElapsed,
  formatModel,
  formatTokens,
  formatTurns,
  groupByKind,
  nearTurnCap,
} from './agent-fleet';
import { SPRITE_H, SPRITE_W, _SPRITE_SOURCES, spriteFor } from './pixel-robots';

function agent(over: Partial<ActiveAgent>): ActiveAgent {
  return {
    kind: 'robot',
    runId: 1,
    startedAt: 0,
    ticket: null,
    project: null,
    turns: null,
    maxTurns: null,
    tokens: null,
    model: null,
    detail: null,
    ...over,
  };
}

describe('groupByKind', () => {
  it('groups in fixed kind order, oldest first, and omits empty kinds', () => {
    const groups = groupByKind([
      agent({ kind: 'auditor', runId: 9, startedAt: 5 }),
      agent({ kind: 'robot', runId: 2, startedAt: 20 }),
      agent({ kind: 'robot', runId: 1, startedAt: 10 }),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(['robot', 'auditor']);
    expect(groups[0].agents.map((a) => a.runId)).toEqual([1, 2]);
  });

  it('is empty for an idle fleet', () => {
    expect(groupByKind([])).toEqual([]);
  });
});

describe('formatters', () => {
  it('formats tokens, showing unknown as a dash rather than zero', () => {
    expect(formatTokens(null)).toBe('—');
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(850)).toBe('850');
    expect(formatTokens(34_210)).toBe('34.2k');
    expect(formatTokens(128_400)).toBe('128k');
    expect(formatTokens(1_240_000)).toBe('1.2M');
  });

  it('formats turns against a ceiling when there is one', () => {
    expect(formatTurns(null, 50)).toBe('—');
    expect(formatTurns(12, 50)).toBe('12/50');
    expect(formatTurns(12, null)).toBe('12');
  });

  it('flags the last fifth of the turn ceiling', () => {
    expect(nearTurnCap(39, 50)).toBe(false);
    expect(nearTurnCap(40, 50)).toBe(true);
    expect(nearTurnCap(40, null)).toBe(false);
    expect(nearTurnCap(null, 50)).toBe(false);
  });

  it('shortens Claude model ids and passes anything else through', () => {
    expect(formatModel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(formatModel('claude-sonnet-4-8')).toBe('Sonnet 4.8');
    expect(formatModel('claude-haiku-5')).toBe('Haiku 5');
    expect(formatModel('gpt-x')).toBe('gpt-x');
    expect(formatModel(null)).toBe('—');
  });

  it('formats elapsed time', () => {
    expect(formatElapsed(0, 45_000)).toBe('45s');
    expect(formatElapsed(0, 12 * 60_000)).toBe('12m');
    expect(formatElapsed(0, 65 * 60_000)).toBe('1h 05m');
    expect(formatElapsed(10_000, 0)).toBe('0s');
  });
});

describe('botColor / agentKey', () => {
  it("uses the project's hex colour, else the default steel", () => {
    expect(botColor(agent({ project: { id: 1, name: 'PD', color: '#3B82F6' } }))).toBe('#3B82F6');
    expect(botColor(agent({ project: { id: 1, name: 'PD', color: 'red; background:url(x)' } }))).toBe(DEFAULT_BOT_COLOR);
    expect(botColor(agent({ project: null }))).toBe(DEFAULT_BOT_COLOR);
  });

  it('keys a tile by kind and run, since run ids are per-table', () => {
    expect(agentKey({ kind: 'robot', runId: 3 })).not.toBe(agentKey({ kind: 'evaluator', runId: 3 }));
  });
});

describe('pixel robots', () => {
  it('every sprite source row fits the grid', () => {
    expect(_SPRITE_SOURCES.BASE).toHaveLength(SPRITE_H);
    for (const rows of [_SPRITE_SOURCES.BASE, ...Object.values(_SPRITE_SOURCES.OVERLAYS)]) {
      expect(rows.length).toBeLessThanOrEqual(SPRITE_H);
      for (const r of rows) expect(r).toHaveLength(SPRITE_W);
    }
  });

  it('gives each kind its accessory', () => {
    const cells = (k: Parameters<typeof spriteFor>[0]) => new Set(spriteFor(k).map((p) => p.c));
    expect(cells('robot').has('K')).toBe(false);
    expect(cells('evaluator').has('K')).toBe(true); // magnifying glass
    expect(cells('auditor').has('V')).toBe(true); // green visor
    expect(cells('sleeping').has('E')).toBe(false); // eyes shut
    expect(spriteFor('evaluator').some((p) => p.part === 'tool')).toBe(true);
  });
});
