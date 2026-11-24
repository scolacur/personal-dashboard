import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  MAX_USAGE_LIMIT,
  bootstrapWidgetUsageSchema,
  listWidgetUsage,
  recordWidgetUse,
} from './widget-usage';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  bootstrapWidgetUsageSchema(db);
});

describe('bootstrapWidgetUsageSchema', () => {
  it('is idempotent', () => {
    expect(() => bootstrapWidgetUsageSchema(db)).not.toThrow();
  });

  it('does not wipe existing usage on a later boot', () => {
    recordWidgetUse(db, 'diary', 1000);
    bootstrapWidgetUsageSchema(db);
    expect(listWidgetUsage(db)).toEqual([{ widgetId: 'diary', lastUsedAt: 1000, useCount: 1 }]);
  });

  it('starts empty — a fresh install has no usage', () => {
    expect(listWidgetUsage(db)).toEqual([]);
  });
});

describe('recordWidgetUse', () => {
  it('inserts a first use with a count of one', () => {
    expect(recordWidgetUse(db, 'pomodoro', 500)).toEqual({
      widgetId: 'pomodoro',
      lastUsedAt: 500,
      useCount: 1,
    });
  });

  it('bumps the count and timestamp on a repeat use', () => {
    recordWidgetUse(db, 'pomodoro', 500);
    expect(recordWidgetUse(db, 'pomodoro', 900)).toEqual({
      widgetId: 'pomodoro',
      lastUsedAt: 900,
      useCount: 2,
    });
  });

  it('never moves a widget back in time on an out-of-order write', () => {
    recordWidgetUse(db, 'pomodoro', 900);
    expect(recordWidgetUse(db, 'pomodoro', 500)).toMatchObject({ lastUsedAt: 900, useCount: 2 });
  });
});

describe('listWidgetUsage', () => {
  it('orders most recently used first', () => {
    recordWidgetUse(db, 'a', 100);
    recordWidgetUse(db, 'b', 300);
    recordWidgetUse(db, 'c', 200);
    recordWidgetUse(db, 'a', 400);
    expect(listWidgetUsage(db).map((u) => u.widgetId)).toEqual(['a', 'b', 'c']);
  });

  it('breaks timestamp ties by id so the order is stable', () => {
    recordWidgetUse(db, 'z', 100);
    recordWidgetUse(db, 'm', 100);
    expect(listWidgetUsage(db).map((u) => u.widgetId)).toEqual(['m', 'z']);
  });

  it('honours limit and clamps it to [1, MAX_USAGE_LIMIT]', () => {
    for (let i = 0; i < 5; i++) recordWidgetUse(db, `w${i}`, i);
    expect(listWidgetUsage(db, 2)).toHaveLength(2);
    expect(listWidgetUsage(db, 0)).toHaveLength(1);
    expect(listWidgetUsage(db, MAX_USAGE_LIMIT * 10)).toHaveLength(5);
  });
});
