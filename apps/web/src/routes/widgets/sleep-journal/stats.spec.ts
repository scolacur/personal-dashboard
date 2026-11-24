import { describe, expect, it } from 'vitest';
import { sleepNightInstants, type SleepEntry } from '@dashboard/shared';
import { averageBedtime, averageWakeTime, byTag, fmtAvg, rangeSince, summarize } from './stats';

let nextId = 1;
function night(wakeDate: string, sleep: string, wake: string, rested: number, tags: [string, number][] = []): SleepEntry {
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  const { sleepAt, wakeAt } = sleepNightInstants(wakeDate, toMin(sleep), toMin(wake));
  return {
    id: nextId++,
    clientId: `c${nextId}`,
    wakeDate,
    sleepAt,
    wakeAt,
    rested,
    tags: tags.map(([name, count]) => ({ name, count })),
    notes: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('rangeSince', () => {
  it('counts today as day 1, and All has no floor', () => {
    expect(rangeSince('7d', '2026-11-24')).toBe('2026-11-18');
    expect(rangeSince('30d', '2026-11-24')).toBe('2026-10-26');
    expect(rangeSince('all', '2026-11-24')).toBeNull();
  });
});

describe('bed and wake time averages', () => {
  it('averages bedtimes across midnight', () => {
    expect(averageBedtime([23 * 60 + 30, 30])).toBe(0); // 23:30 and 00:30 → midnight
    expect(averageBedtime([22 * 60, 23 * 60])).toBe(22 * 60 + 30);
    expect(averageBedtime([])).toBeNull();
  });

  it('averages wake times plainly', () => {
    expect(averageWakeTime([6 * 60, 7 * 60])).toBe(6 * 60 + 30);
  });
});

describe('summarize', () => {
  it('averages duration, rested and times of day', () => {
    const s = summarize([night('2026-11-24', '23:00', '07:00', 4), night('2026-11-23', '00:00', '07:00', 2)]);
    expect(s).toEqual({
      n: 2,
      avgDurationMs: 7.5 * 3_600_000,
      avgRested: 3,
      avgSleepMinutes: 23 * 60 + 30,
      avgWakeMinutes: 7 * 60,
    });
  });

  it('is all nulls for no nights', () => {
    expect(summarize([])).toEqual({ n: 0, avgDurationMs: null, avgRested: null, avgSleepMinutes: null, avgWakeMinutes: null });
  });
});

describe('byTag', () => {
  it('compares rested with a tag against without it, most-used first, with the average count', () => {
    const r = byTag([
      night('2026-11-24', '23:00', '07:00', 5, [['Magnesium', 2]]),
      night('2026-11-23', '23:00', '07:00', 4, [
        ['Magnesium', 1],
        ['Melatonin', 1],
      ]),
      night('2026-11-22', '23:00', '07:00', 2),
      night('2026-11-21', '23:00', '07:00', 1),
    ]);
    expect(r.map((t) => t.tag)).toEqual(['Magnesium', 'Melatonin']);
    expect(r[0]).toEqual({ tag: 'Magnesium', with: { n: 2, avg: 4.5 }, without: { n: 2, avg: 1.5 }, avgCount: 1.5 });
    expect(r[1].without).toEqual({ n: 3, avg: 8 / 3 });
  });

  it('is empty when nothing is tagged', () => {
    expect(byTag([night('2026-11-24', '23:00', '07:00', 3)])).toEqual([]);
  });
});

describe('fmtAvg', () => {
  it('shows one decimal, dropping .0', () => {
    expect(fmtAvg(4)).toBe('4');
    expect(fmtAvg(3.25)).toBe('3.3');
  });
});
