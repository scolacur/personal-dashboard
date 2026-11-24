import { describe, expect, it } from 'vitest';
import { sleepInstantAt, sleepNightInstants, sleepWakeDate, sleepWallClock } from '@dashboard/shared';
import { formatClock, formatDuration, fromTimeInput, roundDownToFive, todayWakeDate, toTimeInput } from './time';

const HOUR = 3_600_000;

describe('home-zone wall clock (shared)', () => {
  it('reads New York time whatever the machine zone', () => {
    // 03:30 UTC on the 24th is 22:30 EST on the 23rd.
    expect(sleepWallClock(Date.UTC(2026, 10, 24, 3, 30))).toEqual({ date: '2026-11-23', minutes: 22 * 60 + 30 });
    expect(sleepWakeDate(Date.UTC(2026, 10, 24, 3, 30))).toBe('2026-11-23');
  });

  it('round-trips a wall-clock time, including across DST', () => {
    expect(sleepInstantAt('2026-11-24', 7 * 60)).toBe(Date.UTC(2026, 10, 24, 12, 0)); // EST
    expect(sleepInstantAt('2026-07-04', 7 * 60)).toBe(Date.UTC(2026, 6, 4, 11, 0)); // EDT
    // The night clocks go back (1 Nov 2026): 23:00 EDT → 07:00 EST is 9 hours.
    const { sleepAt, wakeAt } = sleepNightInstants('2026-11-01', 23 * 60, 7 * 60);
    expect(wakeAt - sleepAt).toBe(9 * HOUR);
  });

  it('puts a sleep later in the day than the wake on the evening before, otherwise the same date', () => {
    const late = sleepNightInstants('2026-11-24', 23 * 60 + 10, 6 * 60 + 35);
    expect(sleepWallClock(late.sleepAt).date).toBe('2026-11-23');
    expect(late.wakeAt - late.sleepAt).toBe(7 * HOUR + 25 * 60_000);
    const afterMidnight = sleepNightInstants('2026-11-24', 60 + 30, 8 * 60);
    expect(sleepWallClock(afterMidnight.sleepAt).date).toBe('2026-11-24');
  });
});

describe('time inputs', () => {
  it('round-trips HH:MM', () => {
    expect(toTimeInput(23 * 60 + 5)).toBe('23:05');
    expect(fromTimeInput('23:05')).toBe(23 * 60 + 5);
    expect(fromTimeInput('07:00:00')).toBe(420);
  });

  it('rejects junk', () => {
    expect(fromTimeInput('')).toBeNull();
    expect(fromTimeInput('25:00')).toBeNull();
    expect(fromTimeInput('late')).toBeNull();
  });

  it('rounds down to five minutes', () => {
    expect(roundDownToFive(7 * 60 + 23)).toBe(7 * 60 + 20);
    expect(roundDownToFive(7 * 60 + 25)).toBe(7 * 60 + 25);
  });
});

describe('formatting', () => {
  it('formats durations', () => {
    expect(formatDuration(7 * HOUR + 25 * 60_000)).toBe('7h 25m');
    expect(formatDuration(8 * HOUR)).toBe('8h');
    expect(formatDuration(45 * 60_000)).toBe('45m');
    expect(formatDuration(-1)).toBe('–');
  });

  it('formats a clock time and today in the home zone', () => {
    expect(formatClock(Date.UTC(2026, 10, 24, 4, 10))).toBe('23:10');
    expect(todayWakeDate(Date.UTC(2026, 10, 24, 4, 10))).toBe('2026-11-23');
  });
});
