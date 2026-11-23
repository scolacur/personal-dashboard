import { describe, expect, it } from 'vitest';
import { CHECKING, healthView } from './health-status';

describe('healthView (PD-937)', () => {
  it('is Healthy only for { ok: true }', () => {
    expect(healthView({ ok: true })).toEqual({ label: 'Healthy', tone: 'ok' });
  });

  it('is Unreachable for a response that is not ok', () => {
    expect(healthView({ ok: false })).toEqual({ label: 'Unreachable', tone: 'bad' });
    expect(healthView({})).toEqual({ label: 'Unreachable', tone: 'bad' });
    expect(healthView({ ok: 'true' })).toEqual({ label: 'Unreachable', tone: 'bad' });
    expect(healthView(null)).toEqual({ label: 'Unreachable', tone: 'bad' });
  });

  it('is Unreachable when the request failed', () => {
    expect(healthView(undefined)).toEqual({ label: 'Unreachable', tone: 'bad' });
  });

  it('starts neutral while checking', () => {
    expect(CHECKING).toEqual({ label: 'Checking…', tone: 'neutral' });
  });
});
