import { describe, expect, it } from 'vitest';
import type { MaintenanceHold } from '@dashboard/shared';
import { HOLD_CADENCE_MS, HOLD_WINDOW_MS } from '@dashboard/shared';
import {
  durationLabel,
  holdDurationMs,
  holdExplainer,
  holdStatusLabel,
  runNowDisabledReason,
  startHoldDisabledReason,
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

  it('says running Robots are allowed to finish — the non-obvious part', () => {
    expect(holdExplainer()).toContain('already working are');
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

describe('holdExplainer — what it promises must match the coordinator', () => {
  it('says a hold is queued unconditionally, not "when convenient"', () => {
    // The first copy said the hold "only opens once every in-flight run has finished — so it may
    // wait", which reads as an indefinite wait on a busy queue. That is not what the coordinator
    // does: it holds dispatch the moment the hold is QUEUED, so the queue cannot refill and the
    // wait is bounded by the Robots already running.
    const text = holdExplainer();
    expect(text).toContain('no matter what');
    expect(text).toContain('no further Robots are dispatched');
    expect(text).not.toContain('it may wait');
  });

  it('describes the order: queue, stop dispatching, drain, open', () => {
    const text = holdExplainer();
    expect(text.indexOf('queued')).toBeLessThan(text.indexOf('allowed to finish'));
    expect(text.indexOf('allowed to finish')).toBeLessThan(text.indexOf('opens as soon as'));
  });
});

describe('startHoldDisabledReason', () => {
  it('is enabled when there is no hold', () => {
    expect(startHoldDisabledReason(null, null)).toBeNull();
  });

  it('is disabled while a hold is already open', () => {
    expect(startHoldDisabledReason(hold({ status: 'active' }), null)).toContain('already open');
  });

  it('is disabled while one is already queued — pressing again would mean nothing', () => {
    expect(startHoldDisabledReason(null, hold({ status: 'queued' }))).toContain('already queued');
  });
});
