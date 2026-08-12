import { describe, it, expect } from 'vitest';
import type { SystemStatus } from '@dashboard/shared';
import { HOLD_LABELS, describeDispatch } from './dispatch-killswitch-utils';

const NOW = 1_000_000;

function status(over: Partial<SystemStatus> = {}): SystemStatus {
  return {
    sortie: {},
    workers: [],
    dispatch: { paused: false, reason: null, since: null },
    sessionLimit: null,
    budget: null,
    githubRateLimit: null,
    ...over,
  };
}

describe('describeDispatch', () => {
  it('returns null before the first poll lands', () => {
    expect(describeDispatch(null, NOW)).toBeNull();
  });

  it('offers Pause while the loop is running', () => {
    expect(describeDispatch(status(), NOW)).toMatchObject({
      mode: 'running',
      action: 'pause',
      detail: null,
    });
  });

  it('offers Resume when paused, and surfaces the reason', () => {
    const s = status({ dispatch: { paused: true, reason: 'budget ceiling reached', since: 500 } });
    expect(describeDispatch(s, NOW)).toMatchObject({
      mode: 'paused',
      action: 'resume',
      detail: 'budget ceiling reached',
      resumeBlockedByHold: false,
    });
  });

  it('falls back to a reason when the pause recorded none', () => {
    const s = status({ dispatch: { paused: true, reason: null, since: 500 } });
    expect(describeDispatch(s, NOW)?.detail).toBe('paused by human');
  });

  // The point of the three-mode split. A session-limit hold stops dispatch, but `robot.ts` gates on
  // it SEPARATELY from `dispatch_paused` and the resume endpoint clears only the latter — so a
  // Resume button here would clear the wrong flag and appear to do nothing.
  it('offers NO action while holding for a session limit — the hold clears itself', () => {
    const s = status({ sessionLimit: { kind: 'session-limit', until: NOW + 60_000, reason: 'session limit', since: 500 } });
    expect(describeDispatch(s, NOW)).toMatchObject({ mode: 'holding', action: null });
    expect(describeDispatch(s, NOW)?.detail).toMatch(/^resumes /);
  });

  it('treats an expired hold as gone, without waiting for the next poll', () => {
    const s = status({ sessionLimit: { kind: 'session-limit', until: NOW - 1, reason: 'session limit', since: 500 } });
    expect(describeDispatch(s, NOW)?.mode).toBe('running');
  });

  // Both halts at once: resuming is still right, but it does not re-arm dispatch on its own and
  // the UI has to say so rather than imply the click was enough.
  it('flags that Resume will not re-arm while a hold is also active', () => {
    const s = status({
      dispatch: { paused: true, reason: 'auth fault', since: 500 },
      sessionLimit: { kind: 'session-limit', until: NOW + 60_000, reason: 'session limit', since: 500 },
    });
    expect(describeDispatch(s, NOW)).toMatchObject({
      mode: 'paused',
      action: 'resume',
      resumeBlockedByHold: true,
    });
  });
});

// PD-248: both holds end by themselves, but they are not the same news. A spent Anthropic quota is
// purely a wait; GitHub throttling the loop means something is hammering the API and is worth
// looking into. A nav that says "session limit" for the second one sends you to the wrong place.
describe('naming which hold is in force (PD-248)', () => {
  it('labels a GitHub rate-limit hold distinctly from a session limit', () => {
    const gh = describeDispatch(
      status({ sessionLimit: { kind: 'github-rate-limit', until: NOW + 60_000, reason: 'HTTP 429', since: 500 } }),
      NOW,
    );
    const session = describeDispatch(
      status({ sessionLimit: { kind: 'session-limit', until: NOW + 60_000, reason: 'quota', since: 500 } }),
      NOW,
    );
    expect(gh?.label).toBe(HOLD_LABELS['github-rate-limit']);
    expect(session?.label).toBe(HOLD_LABELS['session-limit']);
    expect(gh?.label).not.toBe(session?.label);
  });

  it('still offers no action for either — neither needs a human', () => {
    for (const kind of ['github-rate-limit', 'session-limit'] as const) {
      const v = describeDispatch(status({ sessionLimit: { kind, until: NOW + 60_000, reason: 'r', since: 500 } }), NOW);
      expect(v).toMatchObject({ mode: 'holding', action: null, holdKind: kind });
    }
  });

  it('reports the hold kind alongside a pause, so "Resume will not re-arm" can say why', () => {
    const v = describeDispatch(
      status({
        dispatch: { paused: true, reason: 'auth fault', since: 500 },
        sessionLimit: { kind: 'github-rate-limit', until: NOW + 60_000, reason: 'HTTP 429', since: 500 },
      }),
      NOW,
    );
    expect(v).toMatchObject({ mode: 'paused', resumeBlockedByHold: true, holdKind: 'github-rate-limit' });
  });

  it('has no hold kind when nothing is holding', () => {
    expect(describeDispatch(status(), NOW)?.holdKind).toBeNull();
  });
});
