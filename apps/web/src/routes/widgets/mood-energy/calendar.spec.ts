import { describe, expect, it } from 'vitest';
import type { MoodEnergyEntry } from '@dashboard/shared';
import { buildCells, weekSpanCount } from './calendar';

const entry = (day: string): MoodEnergyEntry => ({
  id: 1,
  day,
  recordedAt: 0,
  mood: 4,
  energy: 2,
  tags: [],
  note: null,
  createdAt: 0,
  updatedAt: 0,
});

describe('buildCells', () => {
  it('lays out Mon–Sun rows with entries and future days marked', () => {
    const cells = buildCells(['2026-11-16', '2026-11-23'], new Map([['2026-11-18', entry('2026-11-18')]]), '2026-11-24');
    expect(cells).toHaveLength(14);
    expect(cells[2]).toMatchObject({ day: '2026-11-18', row: 0, col: 2, dayNum: 18, future: false });
    expect(cells[2].entry?.mood).toBe(4);
    expect(cells[8]).toMatchObject({ day: '2026-11-24', row: 1, col: 1, entry: null, future: false });
    expect(cells[9].future).toBe(true);
  });
});

describe('weekSpanCount', () => {
  it('counts weeks inclusively, at least one', () => {
    expect(weekSpanCount('2026-11-24', '2026-11-24')).toBe(1);
    expect(weekSpanCount('2026-11-16', '2026-11-24')).toBe(2);
    expect(weekSpanCount('2026-11-30', '2026-11-24')).toBe(1);
  });
});
