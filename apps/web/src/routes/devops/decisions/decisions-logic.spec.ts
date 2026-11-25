import { describe, it, expect } from 'vitest';
import {
  askedAgo,
  decisionKind,
  ESCALATION_DECISION_KIND,
  escalationHeading,
  escalationLensesToShow,
  escalationReasonDetail,
  escalationReasonLabel,
} from './decisions-logic';

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

describe('escalation helpers (PD-1007)', () => {
  const lens = (l: 'code' | 'security', verdict: 'escalate' | 'revise' | 'ship' | null, summary = '', findings = 0) => ({
    lens: l,
    verdict,
    summary,
    blockingFindings: Array.from({ length: findings }, () => ({ kind: 'ac-unmet' as const, where: 'a.ts:1', what: 'x' })),
  });

  it('has its own decision kind', () => {
    expect(ESCALATION_DECISION_KIND).toBe('escalation');
  });

  it('labels each reason for the chip', () => {
    expect(escalationReasonLabel('escalate')).toBe('Escalated');
    expect(escalationReasonLabel('round-cap')).toBe('Round cap');
    expect(escalationReasonLabel('no-verdict')).toBe('No verdict');
  });

  it('explains each reason, naming the lens behind it', () => {
    expect(escalationReasonDetail({ reason: 'escalate', round: 1, lenses: [lens('code', 'ship'), lens('security', 'escalate')] })).toBe(
      'The security review escalated it in round 1.',
    );
    expect(escalationReasonDetail({ reason: 'round-cap', round: 2, lenses: [lens('code', 'revise')] })).toBe(
      'Changes were still requested at the round cap (round 2).',
    );
    expect(escalationReasonDetail({ reason: 'no-verdict', round: 1, lenses: [lens('code', 'ship'), lens('security', null)] })).toBe(
      'The security review produced no verdict after its one retry.',
    );
  });

  it('heads the card with the ticket, or the PR when there is none', () => {
    expect(escalationHeading({ prNumber: 570, ticket: { id: 2, displayId: 'PD-2', title: 'T' } })).toEqual({ id: 'PD-2', title: 'T' });
    expect(escalationHeading({ prNumber: 570, ticket: null })).toEqual({ id: 'PR #570', title: 'No linked ticket' });
  });

  it('shows only lenses with a summary or blocking findings', () => {
    const shown = escalationLensesToShow([lens('code', 'escalate', 'Why'), lens('security', null), lens('security', 'revise', '', 1)]);
    expect(shown.map((l) => [l.lens, l.verdict])).toEqual([
      ['code', 'escalate'],
      ['security', 'revise'],
    ]);
  });
});
