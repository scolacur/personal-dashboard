import { describe, expect, it } from 'vitest';
import { habitWeeksEndingAt, type SleepEntry } from '@dashboard/shared';
import { buildCells, weekSpanCount } from './calendar';

describe('buildCells', () => {
  it('lays nights out Mon–Sun, newest week last, marking future days and filled nights', () => {
    const weeks = habitWeeksEndingAt('2026-11-23', 2); // Mondays 16 and 23 Nov
    const e = { id: 1, wakeDate: '2026-11-20', rested: 4 } as SleepEntry;
    const cells = buildCells(weeks, new Map([[e.wakeDate, e]]), '2026-11-24');
    expect(cells).toHaveLength(14);
    expect(cells[0]).toMatchObject({ date: '2026-11-16', row: 0, col: 0, dayNum: 16, entry: null, future: false });
    expect(cells.find((c) => c.date === '2026-11-20')?.entry).toBe(e);
    expect(cells.find((c) => c.date === '2026-11-24')?.future).toBe(false);
    expect(cells.at(-1)).toMatchObject({ date: '2026-11-29', row: 1, col: 6, future: true });
  });
});

describe('weekSpanCount', () => {
  it('counts weeks inclusively', () => {
    expect(weekSpanCount('2026-11-24', '2026-11-24')).toBe(1);
    expect(weekSpanCount('2026-11-16', '2026-11-24')).toBe(2);
    expect(weekSpanCount('2026-12-01', '2026-11-24')).toBe(1);
  });
});
