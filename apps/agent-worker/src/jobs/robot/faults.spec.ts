import { describe, it, expect } from 'vitest';
import {
  classifyFault,
  decideFault,
  preflight,
  backoffMs,
  nextEligibleAt,
  normalizeSignature,
  MAX_TURNS_SIGNATURE,
  parseResetAt,
  SESSION_LIMIT_FALLBACK_MS,
  SESSION_LIMIT_MAX_WAIT_MS,
  SESSION_LIMIT_SIGNATURE,
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

  it('classifies a per-run max-turns cutoff with the stable max-turns signature (still transient)', () => {
    const c = classifyFault({ verifyOk: false, error: 'Reached maximum number of turns (50)' });
    expect(c.tier).toBe('transient');
    expect(c.signature).toBe(MAX_TURNS_SIGNATURE);
  });

  it('treats another unrecognised error as a generic transient', () => {
    const c = classifyFault({ verifyOk: false, error: 'some weird flake' });
    expect(c.tier).toBe('transient');
    expect(c.signature).not.toBe(MAX_TURNS_SIGNATURE);
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

  // ── PD-406: max-turns on an unchanged body parks (no futile retry) ──
  const maxTurns = () => classifyFault({ verifyOk: false, error: 'Reached maximum number of turns (50)' });

  it('PD-406: max-turns on the first failure (no prior) parks deterministically — skips the wasted retry', () => {
    expect(decideFault(maxTurns(), [], policy, 'hashA')).toMatchObject({ action: 'park', tier: 'deterministic' });
  });

  it('PD-406: max-turns with a prior failure on the SAME body hash parks deterministically', () => {
    const prior: FailedRun[] = [{ tier: 'transient', signature: MAX_TURNS_SIGNATURE, finishedAt: 1, bodyHash: 'hashA' }];
    expect(decideFault(maxTurns(), prior, policy, 'hashA')).toMatchObject({ action: 'park', tier: 'deterministic' });
  });

  it('PD-406: max-turns after the body CHANGED since the last failure still retries', () => {
    const prior: FailedRun[] = [{ tier: 'transient', signature: MAX_TURNS_SIGNATURE, finishedAt: 1, bodyHash: 'oldHash' }];
    expect(decideFault(maxTurns(), prior, policy, 'newHash').action).toBe('retry');
  });

  it('PD-406: a changed-body max-turns is still bounded by the retry cap', () => {
    const prior: FailedRun[] = [
      { tier: 'transient', signature: MAX_TURNS_SIGNATURE, finishedAt: 1, bodyHash: 'h1' },
      { tier: 'transient', signature: MAX_TURNS_SIGNATURE, finishedAt: 2, bodyHash: 'h2' },
    ];
    expect(decideFault(maxTurns(), prior, policy, 'h3')).toMatchObject({ action: 'park', tier: 'transient' });
  });

  it('PD-406: missing hashes (legacy runs) are treated as unchanged → park', () => {
    const prior: FailedRun[] = [{ tier: 'transient', signature: MAX_TURNS_SIGNATURE, finishedAt: 1, bodyHash: null }];
    expect(decideFault(maxTurns(), prior, policy, null)).toMatchObject({ action: 'park', tier: 'deterministic' });
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

// ── PD-470: the session limit ────────────────────────────────────────────────
// The failure this encodes: on 2026-07-28 PD-420 hit the session limit at ~21:45, run 2 produced an
// identical signature, C2 promoted it to deterministic, and the ticket sat parked ~12h — through a
// quota reset at 1:30 AM — with four tickets stranded behind it.

describe('session-limit faults (PD-470)', () => {
  const ERR = "You've hit your session limit · resets 5:30am (UTC)";
  // 2026-07-29T01:45:00Z — the incident's ~21:45 ET, in the message's own timezone.
  const NOW = Date.UTC(2026, 6, 29, 1, 45);
  const RESET = Date.UTC(2026, 6, 29, 5, 30);

  it('classifies a session limit as its own signature, with the reset time parsed', () => {
    const c = classifyFault({ verifyOk: false, error: ERR }, NOW);
    expect(c.signature).toBe(SESSION_LIMIT_SIGNATURE);
    expect(c.tier).toBe('transient');
    expect(c.resetAt).toBe(RESET);
  });

  it('does NOT read it as the loop-wide auth/credit fault', () => {
    // Both are "the provider said no", but a credit fault needs a human and this one does not.
    expect(classifyFault({ verifyOk: false, error: ERR }, NOW).tier).not.toBe('system-wide');
    expect(classifyFault({ verifyOk: false, error: 'Your credit balance is too low' }, NOW).tier).toBe('system-wide');
  });

  it('waits until the parsed reset instead of retrying on backoff', () => {
    const cls = classifyFault({ verifyOk: false, error: ERR }, NOW);
    expect(decideFault(cls, [], policy, null, NOW)).toMatchObject({ action: 'wait', until: RESET });
  });

  it('never promotes to deterministic, however many times it repeats', () => {
    // The exact shape that stranded PD-420: two identical signatures, which promoteAfter=2 would
    // normally park as deterministic.
    const prior: FailedRun[] = [
      { tier: 'transient', signature: SESSION_LIMIT_SIGNATURE, finishedAt: NOW - 10_000 },
      { tier: 'transient', signature: SESSION_LIMIT_SIGNATURE, finishedAt: NOW - 5000 },
    ];
    const cls = classifyFault({ verifyOk: false, error: ERR }, NOW);
    expect(decideFault(cls, prior, policy, null, NOW)).toMatchObject({ action: 'wait' });
  });

  it('burns no budget: session-limit runs do not count toward the cap or the backoff', () => {
    const prior: FailedRun[] = [
      { tier: 'transient', signature: SESSION_LIMIT_SIGNATURE, finishedAt: 1 },
      { tier: 'transient', signature: SESSION_LIMIT_SIGNATURE, finishedAt: 2 },
      { tier: 'transient', signature: SESSION_LIMIT_SIGNATURE, finishedAt: 3 },
    ];
    expect(preflight(prior, policy, 10_000)).toEqual({ action: 'go' });
    expect(nextEligibleAt(prior, policy)).toBe(0);
    // A real failure still counts normally alongside them.
    const cls = classifyFault({ verifyOk: false });
    expect(decideFault(cls, prior, policy, null, 10_000).action).toBe('retry');
  });

  it('degrades to a bounded wait when the reset time is unreadable — never an indefinite park', () => {
    const cls = classifyFault({ verifyOk: false, error: 'session limit reached, try again later' }, NOW);
    expect(cls.resetAt).toBeNull();
    const d = decideFault(cls, [], policy, null, NOW);
    expect(d).toMatchObject({ action: 'wait', until: NOW + SESSION_LIMIT_FALLBACK_MS });
    expect(d.reason).toContain('unreadable');
  });
});

describe('parseResetAt (PD-470)', () => {
  const NOW = Date.UTC(2026, 6, 29, 1, 45); // 01:45 UTC

  it('reads a 12-hour UTC time later today', () => {
    expect(parseResetAt('resets 5:30am (UTC)', NOW)).toBe(Date.UTC(2026, 6, 29, 5, 30));
  });

  // The overnight case, which is the one that actually happens: it is late, the stated reset is a
  // morning time that already passed today, and the reset being named is tomorrow's.
  it('rolls a time that has already passed to tomorrow', () => {
    const lateNight = Date.UTC(2026, 6, 29, 23, 0);
    expect(parseResetAt('resets 5:30am (UTC)', lateNight)).toBe(Date.UTC(2026, 6, 30, 5, 30));
    expect(parseResetAt('resets 12:30am (UTC)', lateNight)).toBe(Date.UTC(2026, 6, 30, 0, 30)); // 12am = 00
  });

  it('handles pm, a bare hour, and "resets at"', () => {
    expect(parseResetAt('resets 12:15pm (UTC)', NOW)).toBe(Date.UTC(2026, 6, 29, 12, 15));
    expect(parseResetAt('resets at 9 (UTC)', NOW)).toBe(Date.UTC(2026, 6, 29, 9, 0));
  });

  it('returns null for anything it does not confidently understand', () => {
    expect(parseResetAt('session limit reached', NOW)).toBeNull();
    expect(parseResetAt('resets 25:00 (UTC)', NOW)).toBeNull();
    expect(parseResetAt('resets 61 minutes from now', NOW)).toBeNull(); // "61" is not an hour
  });

  it('returns null rather than trusting a parse that lands absurdly far out', () => {
    // A wrong-timezone read could produce a wait of most of a day; the bounded fallback is safer.
    expect(SESSION_LIMIT_MAX_WAIT_MS).toBeLessThan(24 * 60 * 60_000);
    expect(parseResetAt('resets 1:30am (UTC)', NOW)).toBeNull(); // 23h45m out
  });
});
