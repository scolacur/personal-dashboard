import { describe, expect, it } from 'vitest';
import type { MoodEnergyEntry } from '@dashboard/shared';
import {
  DEFAULT_SETTINGS,
  formatDay,
  loadCachedSettings,
  mergeEntries,
  overlayPending,
  parseSettings,
  pendingDay,
  SETTINGS_CACHE_KEY,
  weekdayName,
} from './days';
import type { PendingSave } from './queue';

function kv(initial: Record<string, string> = {}) {
  const store = { ...initial };
  return { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => void (store[k] = v) };
}

function entry(day: string, mood = 3, id = 1): MoodEnergyEntry {
  return { id, day, recordedAt: 0, mood, energy: 3, tags: [], note: null, createdAt: 0, updatedAt: 0 };
}

function save(overrides: Partial<PendingSave> = {}): PendingSave {
  return { clientId: 'c', recordedAt: Date.UTC(2026, 10, 21, 6, 30), mood: 5, energy: 1, tags: ['sad', 'calm'], ...overrides };
}

describe('habit settings cache', () => {
  it('falls back to the shared defaults when nothing valid is cached', () => {
    expect(loadCachedSettings(kv())).toEqual(DEFAULT_SETTINGS);
    expect(loadCachedSettings(kv({ [SETTINGS_CACHE_KEY]: '{bad' }))).toEqual(DEFAULT_SETTINGS);
    expect(loadCachedSettings(kv({ [SETTINGS_CACHE_KEY]: '{"dayBoundaryMinutes":9999,"timezone":"UTC"}' }))).toEqual(
      DEFAULT_SETTINGS,
    );
  });
  it('reads valid cached settings', () => {
    const s = { dayBoundaryMinutes: 0, timezone: 'Europe/London' };
    expect(loadCachedSettings(kv({ [SETTINGS_CACHE_KEY]: JSON.stringify(s) }))).toEqual(s);
    expect(parseSettings({ dayBoundaryMinutes: 60, timezone: 'Not/AZone' })).toBeNull();
  });
});

describe('pending saves', () => {
  it('a 01:30 save belongs to the previous habit day; an explicit day wins', () => {
    expect(pendingDay(save(), DEFAULT_SETTINGS)).toBe('2026-11-20');
    expect(pendingDay(save({ day: '2026-11-02' }), DEFAULT_SETTINGS)).toBe('2026-11-02');
  });

  it('overlays unsent saves on the server entries, last save per day winning, keeping the id', () => {
    const out = overlayPending(
      [entry('2026-11-20', 2, 7), entry('2026-11-19', 4, 6)],
      [save({ mood: 1 }), save({ clientId: 'd', mood: 5 }), save({ clientId: 'e', day: '2026-11-15', mood: 3 })],
      DEFAULT_SETTINGS,
    );
    expect(out.map((e) => [e.day, e.mood, e.id, e.pending ?? false])).toEqual([
      ['2026-11-20', 5, 7, true],
      ['2026-11-19', 4, 6, false],
      ['2026-11-15', 3, -1, true],
    ]);
    expect(out[0].tags).toEqual(['calm', 'sad']);
  });
});

it('mergeEntries replaces by day and sorts newest first', () => {
  const out = mergeEntries([entry('2026-11-19', 1, 1), entry('2026-11-20', 1, 2)], [entry('2026-11-19', 5, 1), entry('2026-11-21', 2, 3)]);
  expect(out.map((e) => [e.day, e.mood])).toEqual([
    ['2026-11-21', 2],
    ['2026-11-20', 1],
    ['2026-11-19', 5],
  ]);
});

it('formats days without the device timezone shifting them', () => {
  expect(weekdayName('2026-11-24')).toBe('Tuesday');
  expect(formatDay('2026-11-24')).toBe('Tue 24 Nov');
  expect(formatDay('2026-11-24', { year: true })).toBe('Tue 24 Nov 2026');
});
