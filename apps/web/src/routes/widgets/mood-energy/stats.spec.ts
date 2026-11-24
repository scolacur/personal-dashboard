import { describe, expect, it } from 'vitest';
import type { MoodEnergyEntry } from '@dashboard/shared';
import { byTag, byWeekday, dailySeries, daysBetween, fmtAvg, inRange, MIN_N, rangeSince, summary } from './stats';

let nextId = 1;
function e(day: string, mood: number, energy = 3, tags: string[] = []): MoodEnergyEntry {
  return { id: nextId++, day, recordedAt: 0, mood, energy, tags, note: null, createdAt: 0, updatedAt: 0 };
}

describe('rangeSince / inRange', () => {
  it('counts today as day 1, and All has no start', () => {
    expect(rangeSince('7d', '2026-11-24')).toBe('2026-11-18');
    expect(rangeSince('30d', '2026-11-24')).toBe('2026-10-26');
    expect(rangeSince('all', '2026-11-24')).toBeNull();
  });
  it('keeps days from since through today', () => {
    const list = [e('2026-11-17', 1), e('2026-11-18', 2), e('2026-11-24', 3)];
    expect(inRange(list, '2026-11-18', '2026-11-24').map((x) => x.mood)).toEqual([2, 3]);
    expect(inRange(list, null, '2026-11-24')).toHaveLength(3);
  });
});

describe('summary and dailySeries', () => {
  it('averages mood and energy, and is null-safe when empty', () => {
    expect(summary([e('2026-11-20', 4, 2), e('2026-11-21', 1, 5)])).toEqual({ n: 2, mood: 2.5, energy: 3.5 });
    expect(summary([])).toEqual({ n: 0, mood: null, energy: null });
  });
  it('orders the series oldest first', () => {
    expect(dailySeries([e('2026-11-21', 1, 5), e('2026-11-19', 4, 2)])).toEqual([
      { day: '2026-11-19', mood: 4, energy: 2 },
      { day: '2026-11-21', mood: 1, energy: 5 },
    ]);
  });
  it('daysBetween counts calendar days across DST', () => {
    expect(daysBetween('2026-11-01', '2026-11-02')).toBe(1);
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
  });
});

describe('byTag', () => {
  it('compares mood on days with a tag against days without, most-used first', () => {
    const r = byTag([e('2026-11-20', 2, 3, ['anxious']), e('2026-11-21', 4, 3, ['anxious', 'calm']), e('2026-11-22', 5), e('2026-11-23', 3)]);
    expect(r.map((t) => t.tag)).toEqual(['anxious', 'calm']);
    expect(r[0]).toEqual({ tag: 'anxious', with: { n: 2, avg: 3 }, without: { n: 2, avg: 4 } });
    expect(r[1].with).toEqual({ n: 1, avg: 4 });
    expect(r[1].with.n).toBeLessThan(MIN_N);
  });
});

describe('byWeekday', () => {
  it('always returns Mon–Sun, averaging mood per weekday', () => {
    // 2026-11-23 is a Monday; 2026-11-16 too.
    const g = byWeekday([e('2026-11-23', 2), e('2026-11-16', 4), e('2026-11-22', 5)]);
    expect(g.map((x) => x.label)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(g[0]).toMatchObject({ n: 2, avg: 3 });
    expect(g[6]).toMatchObject({ n: 1, avg: 5 });
    expect(g[2]).toMatchObject({ n: 0, avg: null });
  });
});

it('fmtAvg rounds to one decimal and drops .0', () => {
  expect(fmtAvg(4)).toBe('4');
  expect(fmtAvg(3.25)).toBe('3.3');
});
