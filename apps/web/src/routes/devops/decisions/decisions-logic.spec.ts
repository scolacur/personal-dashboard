import { describe, it, expect } from 'vitest';
import { askedAgo, decisionKind } from './decisions-logic';

describe('askedAgo (PD-746)', () => {
  const now = 1_000_000_000_000;
  it('reads in the largest sensible unit', () => {
    expect(askedAgo(now - 5_000, now)).toBe('just now');
    expect(askedAgo(now - 12 * 60_000, now)).toBe('12m ago');
    expect(askedAgo(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(askedAgo(now - 47 * 3_600_000, now)).toBe('47h ago');
    expect(askedAgo(now - 3 * 86_400_000, now)).toBe('3d ago');
  });
  it('treats a clock-skewed future time as just now', () => {
    expect(askedAgo(now + 60_000, now)).toBe('just now');
  });
});

describe('decisionKind (PD-843)', () => {
  const proposal = { eventId: 1, proposal: { mode: 'refine_in_place' as const } };
  const round = { questions: [], assumptions: [] };
  it('puts a proposal before a round, and a round before a plain reply', () => {
    expect(decisionKind({ proposal, round })).toBe('proposal');
    expect(decisionKind({ proposal, round: null })).toBe('proposal');
    expect(decisionKind({ proposal: null, round })).toBe('round');
    expect(decisionKind({ proposal: null, round: null })).toBe('reply');
  });
});
