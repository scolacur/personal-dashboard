import { describe, it, expect } from 'vitest';
import { nextCronRun, scheduleLabel } from './cron';

// A fixed reference instant: Tue 2026-07-07 12:00 local.
const REF = new Date(2026, 6, 7, 12, 0, 0, 0).getTime();

describe('nextCronRun', () => {
  it('finds the next weekly Monday 05:00 (audit schedule)', () => {
    const next = nextCronRun('0 5 * * 1', REF);
    const d = new Date(next!);
    expect(d.getDay()).toBe(1); // Monday
    expect(d.getHours()).toBe(5);
    expect(d.getMinutes()).toBe(0);
    // From Tue Jul 7 → the coming Mon Jul 13.
    expect(d.getDate()).toBe(13);
  });

  it('finds the next daily 03:00 (backup schedule) — tomorrow since 12:00 is past it', () => {
    const next = nextCronRun('0 3 * * *', REF);
    const d = new Date(next!);
    expect(d.getHours()).toBe(3);
    expect(d.getDate()).toBe(8);
  });

  it('returns a time strictly in the future', () => {
    expect(nextCronRun('0 5 * * 1', REF)!).toBeGreaterThan(REF);
  });

  it('returns null for a malformed expression', () => {
    expect(nextCronRun('nonsense', REF)).toBeNull();
    expect(nextCronRun('0 5 * *', REF)).toBeNull();
  });
});

describe('scheduleLabel', () => {
  it('labels weekly and daily schedules', () => {
    expect(scheduleLabel('0 5 * * 1')).toBe('Weekly · Mon 5:00 AM');
    expect(scheduleLabel('0 3 * * *')).toBe('Daily · 3:00 AM');
    expect(scheduleLabel('30 14 * * *')).toBe('Daily · 2:30 PM');
  });

  it('falls back to the raw expression for shapes it does not recognise', () => {
    expect(scheduleLabel('*/15 * * * *')).toBe('*/15 * * * *');
  });
});
