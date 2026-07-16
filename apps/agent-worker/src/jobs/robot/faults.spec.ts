import { describe, it, expect } from 'vitest';
import {
  classifyFault,
  decideFault,
  preflight,
  backoffMs,
  nextEligibleAt,
  normalizeSignature,
  type FailedRun,
  type FaultPolicy,
} from './faults';

const policy: FaultPolicy = { retryCap: 3, promoteAfter: 2, backoffBaseMs: 1000, backoffMaxMs: 60_000 };

describe('classifyFault', () => {
  it('flags auth/credit faults as system-wide', () => {
    expect(classifyFault({ verifyOk: false, error: 'GitHub API: HTTP 403 Forbidden' }).tier).toBe('system-wide');
    expect(classifyFault({ verifyOk: false, error: '401 Unauthorized' }).tier).toBe('system-wide');
    expect(classifyFault({ verifyOk: false, error: 'invalid x-api-key' }).tier).toBe('system-wide');
    expect(classifyFault({ verifyOk: false, error: 'Your credit balance is too low' }).tier).toBe('system-wide');
  });

  it('flags path-guard / permission faults as deterministic', () => {
    expect(classifyFault({ verifyOk: false, error: 'refused to edit protected path auth/session.ts' }).tier).toBe('deterministic');
    expect(classifyFault({ verifyOk: false, error: 'EACCES: permission denied' }).tier).toBe('deterministic');
  });

  it('treats a no-verify (no error text) as transient with a stable signature', () => {
    const c = classifyFault({ verifyOk: false });
    expect(c.tier).toBe('transient');
    expect(c.signature).toBe('no-verify');
  });

  it('treats an unrecognised error (e.g. max turns) as transient', () => {
    expect(classifyFault({ verifyOk: false, error: 'max turns exceeded' }).tier).toBe('transient');
  });
});

describe('normalizeSignature', () => {
  it('collapses volatile tokens so the same failure matches across runs', () => {
    const a = normalizeSignature('Error at /wt/robot-220/src/x.ts:42 (sha a1b2c3d4e5f6)');
    const b = normalizeSignature('Error at /wt/robot-220/src/x.ts:99 (sha f6e5d4c3b2a1)');
    expect(a).toBe(b);
  });
});

describe('decideFault', () => {
  it('system-wide → pause (regardless of history)', () => {
    const cls = classifyFault({ verifyOk: false, error: '403 forbidden' });
    expect(decideFault(cls, [], policy).action).toBe('pause');
  });

  it('deterministic → park on the first occurrence (0 retries)', () => {
    const cls = classifyFault({ verifyOk: false, error: 'permission denied' });
    expect(decideFault(cls, [], policy)).toMatchObject({ action: 'park', tier: 'deterministic' });
  });

  it('transient → retry while under the cap and not repeated', () => {
    const cls = classifyFault({ verifyOk: false, error: 'flake' });
    expect(decideFault(cls, [], policy).action).toBe('retry');
  });

  it('promotes transient→deterministic when the same signature repeats promoteAfter times', () => {
    const cls = classifyFault({ verifyOk: false }); // signature 'no-verify'
    const prior: FailedRun[] = [{ tier: 'transient', signature: 'no-verify', finishedAt: 1 }];
    const d = decideFault(cls, prior, policy);
    expect(d).toMatchObject({ action: 'park', tier: 'deterministic' });
    expect(d.reason).toMatch(/repeated 2×/);
  });

  it('parks at the retry cap when signatures differ (no promotion)', () => {
    const cls = classifyFault({ verifyOk: false, error: 'flake-c' });
    const prior: FailedRun[] = [
      { tier: 'transient', signature: 'flake-a', finishedAt: 1 },
      { tier: 'transient', signature: 'flake-b', finishedAt: 2 },
    ];
    expect(decideFault(cls, prior, policy)).toMatchObject({ action: 'park', tier: 'transient' });
  });

  it('excludes system-wide failures from the cap count (zero burn)', () => {
    const cls = classifyFault({ verifyOk: false, error: 'flake-x' });
    const prior: FailedRun[] = [
      { tier: 'system-wide', signature: 'auth', finishedAt: 1 },
      { tier: 'system-wide', signature: 'auth', finishedAt: 2 },
    ];
    // Two system-wide priors must NOT count toward the cap — this is still the first real attempt.
    expect(decideFault(cls, prior, policy).action).toBe('retry');
  });
});

describe('backoff', () => {
  it('grows exponentially and caps', () => {
    expect(backoffMs(1, policy)).toBe(1000);
    expect(backoffMs(2, policy)).toBe(2000);
    expect(backoffMs(3, policy)).toBe(4000);
    expect(backoffMs(20, policy)).toBe(60_000); // capped
  });

  it('nextEligibleAt is 0 with no countable failures and last-finish + backoff otherwise', () => {
    expect(nextEligibleAt([], policy)).toBe(0);
    const prior: FailedRun[] = [{ tier: 'transient', signature: 's', finishedAt: 5000 }];
    expect(nextEligibleAt(prior, policy)).toBe(5000 + 1000);
  });
});

describe('preflight', () => {
  it('go when there is no history', () => {
    expect(preflight([], policy, 10_000)).toEqual({ action: 'go' });
  });

  it('backoff while inside the retry window', () => {
    const prior: FailedRun[] = [{ tier: 'transient', signature: 's', finishedAt: 5000 }];
    expect(preflight(prior, policy, 5500)).toMatchObject({ action: 'backoff' });
    expect(preflight(prior, policy, 6001)).toEqual({ action: 'go' });
  });

  it('park when a deterministic fault is already recorded', () => {
    const prior: FailedRun[] = [{ tier: 'deterministic', signature: 's', finishedAt: 1 }];
    expect(preflight(prior, policy, 10_000).action).toBe('park');
  });

  it('park when the budget is already spent', () => {
    const prior: FailedRun[] = [
      { tier: 'transient', signature: 'a', finishedAt: 1 },
      { tier: 'transient', signature: 'b', finishedAt: 2 },
      { tier: 'transient', signature: 'c', finishedAt: 3 },
    ];
    expect(preflight(prior, policy, 10_000).action).toBe('park');
  });
});
