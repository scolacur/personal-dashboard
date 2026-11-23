import { describe, it, expect } from 'vitest';
import type { ActiveAgent } from '@dashboard/shared';
import {
  AVATAR_FAMILIES,
  AVATAR_LABELS,
  DEFAULT_BOT_COLOR,
  agentKey,
  botColor,
  formatElapsed,
  formatModel,
  formatTokens,
  formatTurns,
  groupByKind,
  isLineStyle,
  nearTurnCap,
} from './agent-fleet';

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
  it('returns every kind as a column in fixed order, oldest first, empty kinds included', () => {
    const groups = groupByKind([
      agent({ kind: 'auditor', runId: 9, startedAt: 5 }),
      agent({ kind: 'robot', runId: 2, startedAt: 20 }),
      agent({ kind: 'robot', runId: 1, startedAt: 10 }),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(['robot', 'evaluator', 'auditor']);
    expect(groups.map((g) => g.agents.length)).toEqual([2, 0, 1]);
    expect(groups[0].agents.map((a) => a.runId)).toEqual([1, 2]);
  });

  it('keeps all three columns for an idle fleet', () => {
    expect(groupByKind([]).every((g) => g.agents.length === 0)).toBe(true);
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

describe('avatar styles', () => {
  it('every style has a label and belongs to exactly one family', () => {
    const all = AVATAR_FAMILIES.flatMap((f) => f.styles);
    expect(new Set(all).size).toBe(all.length);
    for (const st of all) expect(AVATAR_LABELS[st]).toBeTruthy();
  });

  it('tells line faces from signal shapes', () => {
    expect(isLineStyle('tv')).toBe(true);
    expect(isLineStyle('sonar')).toBe(false);
  });
});
