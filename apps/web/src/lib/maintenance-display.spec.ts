import { describe, expect, it } from 'vitest';
import type { MaintenanceHold } from '@dashboard/shared';
import { HOLD_CADENCE_MS, HOLD_WINDOW_MS } from '@dashboard/shared';
import {
  durationLabel,
  holdDurationMs,
  holdExplainer,
  holdStatusLabel,
  runNowDisabledReason,
} from './maintenance-display';

function hold(over: Partial<MaintenanceHold> = {}): MaintenanceHold {
  return {
    id: 1,
    trigger: 'scheduled',
    status: 'completed',
    requestedAt: 1000,
    startedAt: 2000,
    endedAt: 5000,
    note: null,
    runs: [],
    ...over,
  };
}

describe('durationLabel', () => {
  it('reads in minutes below an hour', () => {
    expect(durationLabel(30 * 60_000)).toBe('30 minutes');
    expect(durationLabel(60_000)).toBe('1 minute');
  });

  it('reads in hours above one', () => {
    expect(durationLabel(24 * 60 * 60_000)).toBe('24 hours');
    expect(durationLabel(60 * 60_000)).toBe('1 hour');
    expect(durationLabel(90 * 60_000)).toBe('1.5 hours');
  });
});

describe('holdExplainer', () => {
  it('states the real cadence and window, not hard-coded copy', () => {
    // Built from the shared constants so the page cannot advertise a cadence the coordinator does
    // not keep — the PD-496 drift, where a heading and the code disagreed silently for weeks.
    const text = holdExplainer(HOLD_CADENCE_MS, HOLD_WINDOW_MS);
    expect(text).toContain('24 hours');
    expect(text).toContain('30 minutes');
  });

  it('follows the constants when they change', () => {
    expect(holdExplainer(6 * 60 * 60_000, 10 * 60_000)).toContain('6 hours');
    expect(holdExplainer(6 * 60 * 60_000, 10 * 60_000)).toContain('10 minutes');
  });

  it('says the hold waits for in-flight runs, which is the non-obvious part', () => {
    expect(holdExplainer()).toContain('in-flight');
  });
});

describe('holdStatusLabel', () => {
  it('distinguishes queued from active — the difference the button depends on', () => {
    expect(holdStatusLabel(hold({ status: 'active' }))).toBe('Holding dispatch');
    expect(holdStatusLabel(hold({ status: 'queued' }))).toContain('Queued');
  });

  it('labels the terminal states', () => {
    expect(holdStatusLabel(hold({ status: 'completed' }))).toBe('Completed');
    expect(holdStatusLabel(hold({ status: 'abandoned' }))).toBe('Abandoned');
  });
});

describe('holdDurationMs', () => {
  it('measures from start to end, not from request', () => {
    // Time spent queued is not time dispatch was held.
    expect(holdDurationMs(hold({ requestedAt: 0, startedAt: 2000, endedAt: 5000 }))).toBe(3000);
  });

  it('is null while open or never started', () => {
    expect(holdDurationMs(hold({ endedAt: null }))).toBeNull();
    expect(holdDurationMs(hold({ startedAt: null, endedAt: null }))).toBeNull();
  });
});

describe('runNowDisabledReason', () => {
  it('is null — enabled — during an active hold', () => {
    expect(runNowDisabledReason(hold({ status: 'active' }))).toBeNull();
  });

  it('explains itself when there is no hold, so the tooltip and the disabled state agree', () => {
    const reason = runNowDisabledReason(null);
    expect(reason).toContain('active maintenance hold');
  });
});
