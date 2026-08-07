import { describe, it, expect } from 'vitest';
import type { SystemStatus } from '@dashboard/shared';
import { describeDispatch } from './dispatch-killswitch-utils';

const NOW = 1_000_000;

function status(over: Partial<SystemStatus> = {}): SystemStatus {
  return {
    sortie: {},
    workers: [],
    dispatch: { paused: false, reason: null, since: null },
    sessionLimit: null,
    budget: null,
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
    const s = status({ sessionLimit: { until: NOW + 60_000, reason: 'session limit', since: 500 } });
    expect(describeDispatch(s, NOW)).toMatchObject({ mode: 'holding', action: null });
    expect(describeDispatch(s, NOW)?.detail).toMatch(/^resumes /);
  });

  it('treats an expired hold as gone, without waiting for the next poll', () => {
    const s = status({ sessionLimit: { until: NOW - 1, reason: 'session limit', since: 500 } });
    expect(describeDispatch(s, NOW)?.mode).toBe('running');
  });

  // Both halts at once: resuming is still right, but it does not re-arm dispatch on its own and
  // the UI has to say so rather than imply the click was enough.
  it('flags that Resume will not re-arm while a hold is also active', () => {
    const s = status({
      dispatch: { paused: true, reason: 'auth fault', since: 500 },
      sessionLimit: { until: NOW + 60_000, reason: 'session limit', since: 500 },
    });
    expect(describeDispatch(s, NOW)).toMatchObject({
      mode: 'paused',
      action: 'resume',
      resumeBlockedByHold: true,
    });
  });
});
