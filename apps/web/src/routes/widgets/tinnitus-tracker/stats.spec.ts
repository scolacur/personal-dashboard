import { describe, expect, it } from 'vitest';
import type { TinnitusEntry } from '@dashboard/shared';
import { byDaypart, byTag, dailyAverages, daypartOf, fmtAvg, rangeStart } from './stats';

let nextId = 1;
function e(when: Date, intensity: number, tags: string[] = []): TinnitusEntry {
  const ms = when.getTime();
  return { id: nextId++, clientId: `c${nextId}`, recordedAt: ms, intensity, tags, notes: null, createdAt: ms, updatedAt: ms };
}
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m);

describe('rangeStart', () => {
  const now = at(13, 15).getTime();
  it('starts at local midnight, counting today as day 1', () => {
    expect(rangeStart('7d', now)).toBe(new Date(2026, 10, 7).getTime());
    expect(rangeStart('30d', now)).toBe(new Date(2026, 9, 15).getTime());
  });
  it('All is from the beginning', () => {
    expect(rangeStart('all', now)).toBe(0);
  });
});

describe('dailyAverages', () => {
  it('averages per local day, oldest first, skipping empty days', () => {
    const days = dailyAverages([e(at(12, 9, 45), 3), e(at(10, 17), 5), e(at(10, 21, 30), 5), e(at(12, 16, 20), 4)]);
    expect(days.map((d) => [new Date(d.day).getDate(), d.avg, d.n])).toEqual([
      [10, 5, 2],
      [12, 3.5, 2],
    ]);
  });
});

describe('byTag', () => {
  it('compares readings with a tag against readings without it, most-used first', () => {
    const r = byTag([
      e(at(12, 9), 3, ['caffeine']),
      e(at(12, 16), 4, ['alcohol', 'caffeine']),
      e(at(11, 16), 4),
      e(at(10, 17), 5),
    ]);
    expect(r.map((t) => t.tag)).toEqual(['caffeine', 'alcohol']);
    expect(r[0]).toEqual({ tag: 'caffeine', with: { n: 2, avg: 3.5 }, without: { n: 2, avg: 4.5 } });
    expect(r[1].with).toEqual({ n: 1, avg: 4 });
    expect(r[1].without).toEqual({ n: 3, avg: 4 });
  });

  it('is empty when nothing is tagged', () => {
    expect(byTag([e(at(10, 9), 2)])).toEqual([]);
  });
});

describe('dayparts', () => {
  it('places boundary hours in the later part, and night wraps midnight', () => {
    expect(daypartOf(at(10, 4, 59).getTime())).toBe('night');
    expect(daypartOf(at(10, 5).getTime())).toBe('morning');
    expect(daypartOf(at(10, 12).getTime())).toBe('afternoon');
    expect(daypartOf(at(10, 17).getTime())).toBe('evening');
    expect(daypartOf(at(10, 22).getTime())).toBe('night');
    expect(daypartOf(at(10, 0, 30).getTime())).toBe('night');
  });

  it('always returns four groups in clock order, empty ones with no average', () => {
    const r = byDaypart([e(at(12, 9, 45), 3), e(at(12, 16, 20), 4), e(at(11, 16, 20), 5)]);
    expect(r.map((g) => [g.id, g.n, g.avg])).toEqual([
      ['morning', 1, 3],
      ['afternoon', 2, 4.5],
      ['evening', 0, null],
      ['night', 0, null],
    ]);
  });
});

describe('fmtAvg', () => {
  it('shows one decimal, dropping .0', () => {
    expect(fmtAvg(4)).toBe('4');
    expect(fmtAvg(4.25)).toBe('4.3');
    expect(fmtAvg(3.333)).toBe('3.3');
  });
});
