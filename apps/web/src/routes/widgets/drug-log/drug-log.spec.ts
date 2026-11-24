import { describe, expect, it } from 'vitest';
import {
  DRUG_LOG_FALLBACK_DAY_SETTINGS as NY,
  type DrugLogDrug,
  type HabitSettings,
} from '@dashboard/shared';
import {
  activeDrugs,
  archivedDrugs,
  calendarCells,
  cellIntensity,
  countsByDay,
  countsForDay,
  dayLabel,
  drugStats,
  fetchSinceForDay,
  formatAgo,
  groupByDay,
  labelScale,
  mergeEvents,
  weekSpanCount,
  moveDrug,
  TODAY_LOOKBACK_MS,
} from './drug-log';
import { defaultAddTime, fromLocalInput, toLocalInput } from './time';

/** Unix ms for a New York wall-clock time in November (EST, UTC-5). */
const ny = (date: string, time: string) => Date.parse(`${date}T${time}:00-05:00`);

const drug = (id: number, sortOrder: number, archivedAt: number | null = null): DrugLogDrug => ({
  id,
  label: `D${id}`,
  color: '#2e9e5b',
  sortOrder,
  archivedAt,
  createdAt: 0,
  eventCount: 0,
});

describe('drugs', () => {
  const drugs = [drug(1, 2), drug(2, 0), drug(3, 1, 99), drug(4, 1)];

  it('splits active and archived, each in grid order', () => {
    expect(activeDrugs(drugs).map((d) => d.id)).toEqual([2, 4, 1]);
    expect(archivedDrugs(drugs).map((d) => d.id)).toEqual([3]);
  });

  it('moveDrug renumbers the active list and returns only what changed', () => {
    expect(moveDrug(drugs, 1, -1)).toEqual([
      { id: 1, sortOrder: 1 },
      { id: 4, sortOrder: 2 },
    ]);
    expect(moveDrug(drugs, 2, -1)).toEqual([]);
    expect(moveDrug(drugs, 1, 1)).toEqual([]);
    expect(moveDrug(drugs, 3, 1)).toEqual([]); // archived: not on the grid
  });
});

describe('habit-day counting', () => {
  const taps = [
    { drugId: 1, recordedAt: ny('2026-11-23', '21:00') },
    { drugId: 1, recordedAt: ny('2026-11-24', '02:00') }, // before 04:00 → still the 23rd
    { drugId: 2, recordedAt: ny('2026-11-24', '03:59') },
    { drugId: 1, recordedAt: ny('2026-11-24', '04:00') }, // the 24th
  ];

  it('a 2am tap counts toward the previous day', () => {
    expect(countsForDay(taps, '2026-11-23', NY)).toEqual(
      new Map([
        [1, 2],
        [2, 1],
      ]),
    );
    expect(countsForDay(taps, '2026-11-24', NY)).toEqual(new Map([[1, 1]]));
  });

  it('follows the Habit Tracker settings it is given, not a fixed boundary', () => {
    const midnight: HabitSettings = { ...NY, dayBoundaryMinutes: 0 };
    expect(countsForDay(taps, '2026-11-24', midnight)).toEqual(
      new Map([
        [1, 2],
        [2, 1],
      ]),
    );
  });

  it('countsByDay tallies one drug per day', () => {
    expect(countsByDay(taps, 1, NY)).toEqual(
      new Map([
        ['2026-11-23', 2],
        ['2026-11-24', 1],
      ]),
    );
  });

  it('TODAY_LOOKBACK_MS reaches the start of a 25h DST day', () => {
    expect(TODAY_LOOKBACK_MS).toBeGreaterThan(25 * 3_600_000);
  });
});

describe('groupByDay', () => {
  const events = [
    { id: 1, drugId: 2, recordedAt: ny('2026-11-22', '20:00') },
    { id: 2, drugId: 1, recordedAt: ny('2026-11-22', '22:00') },
    { id: 3, drugId: 1, recordedAt: ny('2026-11-23', '01:00') },
    { id: 4, drugId: 1, recordedAt: ny('2026-11-24', '12:00') },
    { id: 5, drugId: 1, recordedAt: ny('2026-11-10', '12:00') }, // outside the range
  ];

  it('one group per day, newest first, empty days kept, chips in drug order, events newest first', () => {
    const groups = groupByDay(events, [1, 2], '2026-11-21', '2026-11-24', NY);
    expect(groups.map((g) => [g.day, g.total])).toEqual([
      ['2026-11-24', 1],
      ['2026-11-23', 0],
      ['2026-11-22', 3],
      ['2026-11-21', 0],
    ]);
    expect(groups[2].counts).toEqual([
      { drugId: 1, count: 2 },
      { drugId: 2, count: 1 },
    ]);
    expect(groups[2].events.map((e) => e.id)).toEqual([3, 2, 1]);
  });

  it('fetchSinceForDay is before the day starts in any zone', () => {
    expect(fetchSinceForDay('2026-11-21')).toBeLessThan(ny('2026-11-21', '04:00'));
    expect(fetchSinceForDay('2026-11-21')).toBeLessThan(Date.parse('2026-11-21T00:00:00+14:00'));
  });

  it('dayLabel', () => {
    expect(dayLabel('2026-11-24', '2026-11-24')).toBe('Today');
    expect(dayLabel('2026-11-23', '2026-11-24')).toBe('Yesterday');
    expect(dayLabel('2026-11-20', '2026-11-24')).toBe('Fri 20 Nov');
    expect(dayLabel('2025-11-20', '2026-11-24')).toBe('Thu 20 Nov 2025');
  });
});

describe('By Drug calendar', () => {
  it('lays out Mon–Sun cells, blanking the future', () => {
    const counts = new Map([
      ['2026-11-16', 2],
      ['2026-11-24', 1],
    ]);
    const cells = calendarCells(['2026-11-16', '2026-11-23'], counts, '2026-11-24');
    expect(cells).toHaveLength(14);
    expect(cells[0]).toEqual({
      day: '2026-11-16',
      row: 0,
      col: 0,
      dayNum: 16,
      count: 2,
      future: false,
    });
    expect(cells[8]).toMatchObject({ day: '2026-11-24', row: 1, col: 1, count: 1, future: false });
    expect(cells[9]).toMatchObject({ day: '2026-11-25', future: true, count: 0 });
  });

  it('cellIntensity scales by count', () => {
    expect(cellIntensity(0, 5)).toBe(0);
    expect(cellIntensity(5, 5)).toBe(1);
    expect(cellIntensity(1, 1)).toBe(1);
    expect(cellIntensity(1, 10)).toBe(0.37);
    expect(cellIntensity(3, 0)).toBe(0);
  });
});

describe('drugStats', () => {
  const today = '2026-11-24';
  const counts = new Map([
    ['2026-09-01', 4], // outside the last 30
    ['2026-11-01', 1],
    ['2026-11-02', 1],
    ['2026-11-03', 1],
    ['2026-11-04', 1],
    ['2026-11-22', 2],
    ['2026-11-23', 3],
  ]);

  it('totals and averages over the range, counts days used in the last 30', () => {
    const s = drugStats(counts, '2026-11-01', today);
    expect(s.totalInRange).toBe(9);
    expect(s.avgPerActiveDay).toBe(1.5);
    expect(s.daysUsedLast30).toBe(6);
    expect(s.longestStreak).toBe(4);
  });

  it('current streak runs through yesterday when today has no tap yet', () => {
    expect(drugStats(counts, today, today).currentStreak).toBe(2);
    expect(drugStats(new Map([...counts, [today, 1]]), today, today).currentStreak).toBe(3);
    expect(drugStats(new Map([['2026-11-20', 1]]), today, today).currentStreak).toBe(0);
  });

  it('null average with nothing in range', () => {
    expect(drugStats(new Map(), '2026-11-01', today)).toEqual({
      totalInRange: 0,
      daysUsedLast30: 0,
      avgPerActiveDay: null,
      longestStreak: 0,
      currentStreak: 0,
    });
  });
});

describe('formatting', () => {
  it('formatAgo', () => {
    const now = 10_000_000_000;
    expect(formatAgo(now - 5_000, now)).toBe('just now');
    expect(formatAgo(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatAgo(now - 2 * 3_600_000, now)).toBe('2h ago');
    expect(formatAgo(now - 3 * 86_400_000, now)).toBe('3d ago');
    expect(formatAgo(now - 30 * 86_400_000, now)).toBe('4w ago');
    expect(formatAgo(now - 400 * 86_400_000, now)).toBe('1y ago');
  });

  it('labelScale shrinks long labels', () => {
    expect(labelScale('Weed')).toBe(1);
    expect(labelScale('Coffee')).toBe(0.85);
    expect(labelScale('Mushrooms12')).toBe(0.54);
    expect(labelScale('Weed')).toBeGreaterThan(labelScale('Shrooms'));
  });

  it('local datetime round-trips, and defaultAddTime picks now or 21:00', () => {
    const ms = new Date(2026, 10, 24, 14, 5).getTime();
    expect(fromLocalInput(toLocalInput(ms))).toBe(ms);
    expect(fromLocalInput('nope')).toBeNull();
    expect(defaultAddTime('2026-11-24', '2026-11-24', 123)).toBe(123);
    expect(defaultAddTime('2026-11-20', '2026-11-24', 123)).toBe(
      new Date(2026, 10, 20, 21, 0).getTime(),
    );
  });
});

describe('mergeEvents', () => {
  it('upserts by id and keeps newest first', () => {
    const list = [
      { id: 1, recordedAt: 10 },
      { id: 2, recordedAt: 5 },
    ];
    expect(
      mergeEvents(list, [
        { id: 2, recordedAt: 20 },
        { id: 3, recordedAt: 7 },
      ]).map((e) => e.id),
    ).toEqual([2, 1, 3]);
  });
});

describe('weekSpanCount', () => {
  it('counts Mon–Sun weeks inclusively', () => {
    expect(weekSpanCount('2026-11-24', '2026-11-24')).toBe(1);
    expect(weekSpanCount('2026-11-22', '2026-11-24')).toBe(2); // Sun → Tue
    expect(weekSpanCount('2026-12-01', '2026-11-24')).toBe(1);
  });
});
