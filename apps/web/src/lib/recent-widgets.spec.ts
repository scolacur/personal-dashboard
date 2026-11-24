import { describe, it, expect } from 'vitest';
import type { WidgetUsage } from '@dashboard/shared';
import {
  RECENT_WIDGETS_CAP,
  createUseThrottle,
  recentWidgetIds,
  shouldRecordUseAt,
  widgetIdForPath,
} from './recent-widgets';

const u = (widgetId: string, lastUsedAt: number, useCount = 1): WidgetUsage => ({
  widgetId,
  lastUsedAt,
  useCount,
});

describe('recentWidgetIds', () => {
  it('orders newest first', () => {
    expect(recentWidgetIds([u('a', 1), u('b', 3), u('c', 2)], ['a', 'b', 'c'])).toEqual([
      'b',
      'c',
      'a',
    ]);
  });

  it('drops widgets the registry no longer has', () => {
    expect(recentWidgetIds([u('gone', 9), u('a', 1)], ['a'])).toEqual(['a']);
  });

  it('caps the list, keeping the newest', () => {
    const usage = Array.from({ length: 12 }, (_, i) => u(`w${i}`, i));
    const ids = usage.map((x) => x.widgetId);
    const out = recentWidgetIds(usage, ids);
    expect(out).toHaveLength(RECENT_WIDGETS_CAP);
    expect(out[0]).toBe('w11');
    expect(recentWidgetIds(usage, ids, 3)).toEqual(['w11', 'w10', 'w9']);
  });

  it('fills the cap past filtered-out entries', () => {
    expect(recentWidgetIds([u('x', 5), u('a', 4), u('b', 3)], ['a', 'b'], 2)).toEqual(['a', 'b']);
  });

  it('dedupes defensively', () => {
    expect(recentWidgetIds([u('a', 1), u('a', 2)], ['a'])).toEqual(['a']);
  });

  it('is empty with no usage — the caller falls back to curated Home', () => {
    expect(recentWidgetIds([], ['a'])).toEqual([]);
  });

  it('breaks timestamp ties by id', () => {
    expect(recentWidgetIds([u('z', 1), u('m', 1)], ['m', 'z'])).toEqual(['m', 'z']);
  });
});

describe('shouldRecordUseAt', () => {
  it('never records on Home, so Home cannot reinforce itself', () => {
    expect(shouldRecordUseAt('/')).toBe(false);
  });

  it('records everywhere else', () => {
    expect(shouldRecordUseAt('/productivity')).toBe(true);
    expect(shouldRecordUseAt('/widgets/diary')).toBe(true);
    expect(shouldRecordUseAt('/library')).toBe(true);
  });
});

describe('widgetIdForPath', () => {
  const routes = [
    { id: 'diary', route: '/widgets/diary' },
    { id: 'devops-task-tracker', route: '/devops/task-tracker' },
    { id: 'outer', route: '/x' },
    { id: 'inner', route: '/x/y' },
  ];

  it('matches a widget route exactly', () => {
    expect(widgetIdForPath('/widgets/diary', routes)).toBe('diary');
    expect(widgetIdForPath('/devops/task-tracker', routes)).toBe('devops-task-tracker');
  });

  it('matches a sub-path at a path boundary only', () => {
    expect(widgetIdForPath('/widgets/diary/2026-11-24', routes)).toBe('diary');
    expect(widgetIdForPath('/widgets/diary-extra', routes)).toBeUndefined();
  });

  it('prefers the longest matching route', () => {
    expect(widgetIdForPath('/x/y/z', routes)).toBe('inner');
    expect(widgetIdForPath('/x/q', routes)).toBe('outer');
  });

  it('is undefined for non-widget pages', () => {
    expect(widgetIdForPath('/', routes)).toBeUndefined();
    expect(widgetIdForPath('/devops', routes)).toBeUndefined();
  });
});

describe('createUseThrottle', () => {
  it('lets the first use through and holds repeats inside the window', () => {
    let t = 0;
    const th = createUseThrottle(60_000, () => t);
    expect(th.shouldSend('a')).toBe(true);
    t = 59_999;
    expect(th.shouldSend('a')).toBe(false);
    t = 60_000;
    expect(th.shouldSend('a')).toBe(true);
  });

  it('throttles each widget independently', () => {
    const th = createUseThrottle(60_000, () => 0);
    expect(th.shouldSend('a')).toBe(true);
    expect(th.shouldSend('b')).toBe(true);
    expect(th.shouldSend('a')).toBe(false);
  });

  it('measures the window from the last *sent* use, not the last attempt', () => {
    let t = 0;
    const th = createUseThrottle(60_000, () => t);
    th.shouldSend('a');
    t = 30_000;
    th.shouldSend('a'); // suppressed — must not extend the window
    t = 60_000;
    expect(th.shouldSend('a')).toBe(true);
  });
});
