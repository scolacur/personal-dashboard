import { describe, expect, it } from 'vitest';
import { sleepNightInstants, type SleepEntry } from '@dashboard/shared';
import { blankDraft, countsFromTags, draftFromEntry, draftTimes, tagsFromCounts } from './draft';

// 2026-11-24 06:47 EST.
const NOW = Date.UTC(2026, 10, 24, 11, 47);

function entry(over: Partial<SleepEntry> = {}): SleepEntry {
  const { sleepAt, wakeAt } = sleepNightInstants('2026-11-23', 22 * 60 + 40, 6 * 60 + 15);
  return {
    id: 1,
    clientId: 'c',
    wakeDate: '2026-11-23',
    sleepAt,
    wakeAt,
    rested: 4,
    tags: [{ name: 'Magnesium', count: 2 }],
    notes: 'a dream',
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe('blankDraft', () => {
  it('wakes today, now rounded down to 5 min, rested 3, nothing tagged', () => {
    expect(blankDraft(null, NOW)).toEqual({
      wakeDate: '2026-11-24',
      sleepTime: '23:00',
      wakeTime: '06:45',
      rested: 3,
      counts: {},
      notes: '',
    });
  });

  it("copies the previous night's sleep time of day", () => {
    expect(blankDraft(entry(), NOW).sleepTime).toBe('22:40');
  });
});

describe('draftFromEntry', () => {
  it('loads every field', () => {
    expect(draftFromEntry(entry())).toEqual({
      wakeDate: '2026-11-23',
      sleepTime: '22:40',
      wakeTime: '06:15',
      rested: 4,
      counts: { Magnesium: 2 },
      notes: 'a dream',
    });
  });
});

describe('tags <-> counts', () => {
  it('round-trips, sorted by name, dropping zeroes', () => {
    expect(tagsFromCounts({ Melatonin: 1, Magnesium: 3, Gone: 0 })).toEqual([
      { name: 'Magnesium', count: 3 },
      { name: 'Melatonin', count: 1 },
    ]);
    expect(countsFromTags([{ name: 'Magnesium', count: 3 }])).toEqual({ Magnesium: 3 });
  });
});

describe('draftTimes', () => {
  it('builds the night, sleep on the evening before', () => {
    const r = draftTimes({ wakeDate: '2026-11-24', sleepTime: '23:10', wakeTime: '06:35' }, NOW);
    expect(r).toEqual({ ok: true, ...sleepNightInstants('2026-11-24', 23 * 60 + 10, 6 * 60 + 35) });
  });

  it('refuses a wake time in the future, and bad input', () => {
    expect(draftTimes({ wakeDate: '2026-11-24', sleepTime: '23:00', wakeTime: '09:00' }, NOW).ok).toBe(false);
    expect(draftTimes({ wakeDate: '2026-11-24', sleepTime: '', wakeTime: '06:00' }, NOW).ok).toBe(false);
    expect(draftTimes({ wakeDate: '', sleepTime: '23:00', wakeTime: '06:00' }, NOW).ok).toBe(false);
  });
});
