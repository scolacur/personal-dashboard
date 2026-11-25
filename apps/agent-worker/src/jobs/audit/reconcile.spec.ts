import { describe, it, expect } from 'vitest';
import { findingFingerprint, reconcileDecisions, type PriorFinding, type CurrentFinding } from './reconcile';

describe('findingFingerprint', () => {
  it('is stable for identical inputs', () => {
    const a = findingFingerprint({ type: 'archive', evidence: 'superseded by PD-9', proposedChange: 'archive it' });
    const b = findingFingerprint({ type: 'archive', evidence: 'superseded by PD-9', proposedChange: 'archive it' });
    expect(a).toBe(b);
  });

  it('ignores cosmetic whitespace in evidence / proposed change', () => {
    const a = findingFingerprint({ type: 'update', evidence: 'line one\nline two', proposedChange: 'do  x' });
    const b = findingFingerprint({ type: 'update', evidence: '  line one   line two  ', proposedChange: 'do x' });
    expect(a).toBe(b);
  });

  it('changes when the type changes', () => {
    const a = findingFingerprint({ type: 'archive', evidence: 'e', proposedChange: 'p' });
    const b = findingFingerprint({ type: 'complete', evidence: 'e', proposedChange: 'p' });
    expect(a).not.toBe(b);
  });

  it('changes when the evidence changes', () => {
    const a = findingFingerprint({ type: 'update', evidence: 'old evidence', proposedChange: 'p' });
    const b = findingFingerprint({ type: 'update', evidence: 'new evidence', proposedChange: 'p' });
    expect(a).not.toBe(b);
  });

  it('treats null/undefined evidence and proposed change as empty (equal)', () => {
    const a = findingFingerprint({ type: 'keep' });
    const b = findingFingerprint({ type: 'keep', evidence: null, proposedChange: undefined });
    expect(a).toBe(b);
  });

  it('does not collide across a field boundary', () => {
    // ('ab','') must not hash the same as ('a','b') — the separator guards this.
    const a = findingFingerprint({ type: 'update', evidence: 'ab', proposedChange: '' });
    const b = findingFingerprint({ type: 'update', evidence: 'a', proposedChange: 'b' });
    expect(a).not.toBe(b);
  });
});

describe('reconcileDecisions', () => {
  const fp = (s: string) => findingFingerprint({ type: 'update', evidence: s });
  const prior = (ticketId: number, type: string, fingerprint: string | null, decision: PriorFinding['decision']): PriorFinding => ({
    ticketId,
    type,
    fingerprint,
    decision,
  });
  const cur = (ticketId: number, type: string, fingerprint: string): CurrentFinding => ({ ticketId, type, fingerprint });

  it('carries an accepted decision forward when the fingerprint is unchanged', () => {
    const f = fp('same');
    const out = reconcileDecisions([prior(10, 'update', f, 'accepted')], [cur(10, 'update', f)]);
    expect(out).toEqual(['accepted']);
  });

  it('carries a rejected decision forward (suppression) when unchanged', () => {
    const f = fp('same');
    const out = reconcileDecisions([prior(10, 'archive', f, 'rejected')], [cur(10, 'archive', f)]);
    expect(out).toEqual(['rejected']);
  });

  it('resets to undecided when the fingerprint changed (evidence moved)', () => {
    const out = reconcileDecisions([prior(10, 'update', fp('old'), 'rejected')], [cur(10, 'update', fp('new'))]);
    expect(out).toEqual(['undecided']);
  });

  it('is undecided for a finding with no prior match', () => {
    const out = reconcileDecisions([], [cur(11, 'update', fp('x'))]);
    expect(out).toEqual(['undecided']);
  });

  it('matches on (ticket_id, type) — a different type on the same ticket is a new finding', () => {
    const f = fp('x');
    const out = reconcileDecisions([prior(10, 'archive', f, 'accepted')], [cur(10, 'update', f)]);
    expect(out).toEqual(['undecided']);
  });

  it('a prior finding absent from the current set is simply not carried (closed-by-omission)', () => {
    const f = fp('x');
    // Prior has two findings; current only re-raises one. Output has exactly one entry.
    const out = reconcileDecisions(
      [prior(10, 'archive', f, 'accepted'), prior(11, 'update', f, 'rejected')],
      [cur(10, 'archive', f)],
    );
    expect(out).toEqual(['accepted']);
  });

  it('preserves order across a mixed set', () => {
    const a = fp('a');
    const b = fp('b');
    const out = reconcileDecisions(
      [prior(1, 'update', a, 'accepted'), prior(2, 'archive', b, 'rejected')],
      [cur(2, 'archive', fp('b-changed')), cur(1, 'update', a), cur(3, 'keep', fp('c'))],
    );
    expect(out).toEqual(['undecided', 'accepted', 'undecided']);
  });
});
