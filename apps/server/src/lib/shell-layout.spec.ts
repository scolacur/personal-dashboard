import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  bootstrapShellLayoutSchema,
  getAllPageWidgets,
  getPageWidgets,
  setPageWidgets,
} from './shell-layout';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  bootstrapShellLayoutSchema(db);
});

describe('bootstrapShellLayoutSchema', () => {
  it('is idempotent', () => {
    expect(() => bootstrapShellLayoutSchema(db)).not.toThrow();
  });

  it('seeds the pages that had registry membership', () => {
    const all = getAllPageWidgets(db);
    expect(all.productivity.map((w) => w.widgetId)).toEqual([
      'morning-routine',
      'reminders',
      'habit-log',
      'pomodoro',
      'diary',
      'vision-board',
    ]);
    expect(all['music-production'].map((w) => w.widgetId)).toEqual([
      'acute-strategies-generator',
    ]);
  });

  it('seeds Home with its previous contents rather than empty', () => {
    // D-073: the seed is a pure no-visible-change migration. Home is meant to end up
    // hand-curated, but that is a choice made in the UI — seeding it empty would leave Home
    // blank and unfillable until the library ships.
    expect(getPageWidgets(db, 'home').length).toBeGreaterThan(0);
  });

  it('carries each widget span across, defaulting to 1x1', () => {
    const byId = new Map(getPageWidgets(db, 'music-discovery').map((w) => [w.widgetId, w]));
    expect(byId.get('music-tracker')).toMatchObject({ cols: 2, rows: 3 });
    expect(byId.get('music-picker')).toMatchObject({ cols: 1, rows: 1 });
  });

  it('gives every page contiguous order values from zero', () => {
    for (const widgets of Object.values(getAllPageWidgets(db))) {
      expect(widgets.map((w) => w.order)).toEqual(widgets.map((_, i) => i));
    }
  });
});

describe('the seed guard', () => {
  // The regression this file exists for. `bootstrapSchema` runs on every process start, so an
  // unguarded seed re-adds — on the next deploy — every widget the user deliberately removed.
  it('does not resurrect removed widgets on a later boot', () => {
    setPageWidgets(db, 'productivity', [{ widgetId: 'diary', order: 0, cols: 1, rows: 1 }]);

    bootstrapShellLayoutSchema(db);

    expect(getPageWidgets(db, 'productivity').map((w) => w.widgetId)).toEqual(['diary']);
  });

  it('does not re-seed a page the user emptied completely', () => {
    // Keyed off a `shell_meta` marker rather than "is the table empty?", precisely so that a
    // user who empties every page stays emptied across a restart.
    for (const pageId of Object.keys(getAllPageWidgets(db))) {
      setPageWidgets(db, pageId, []);
    }

    bootstrapShellLayoutSchema(db);

    expect(getAllPageWidgets(db)).toEqual({});
  });
});

describe('setPageWidgets', () => {
  it('replaces a page wholesale and renumbers order from array position', () => {
    const result = setPageWidgets(db, 'productivity', [
      { widgetId: 'pomodoro', order: 99, cols: 2, rows: 1 },
      { widgetId: 'diary', order: 4, cols: 1, rows: 1 },
    ]);

    expect(result).toEqual([
      { widgetId: 'pomodoro', order: 0, cols: 2, rows: 1 },
      { widgetId: 'diary', order: 1, cols: 1, rows: 1 },
    ]);
  });

  it('drops a duplicate widget id, keeping the first', () => {
    const result = setPageWidgets(db, 'home', [
      { widgetId: 'diary', order: 0, cols: 2, rows: 2 },
      { widgetId: 'diary', order: 1, cols: 1, rows: 1 },
    ]);

    expect(result).toEqual([{ widgetId: 'diary', order: 0, cols: 2, rows: 2 }]);
  });

  it('clamps a span below one', () => {
    const result = setPageWidgets(db, 'home', [
      { widgetId: 'diary', order: 0, cols: 0, rows: -3 },
    ]);

    expect(result[0]).toMatchObject({ cols: 1, rows: 1 });
  });

  it('empties a page when given an empty array', () => {
    setPageWidgets(db, 'productivity', []);
    expect(getPageWidgets(db, 'productivity')).toEqual([]);
    expect(getAllPageWidgets(db).productivity).toBeUndefined();
  });

  it('leaves other pages untouched', () => {
    const before = getPageWidgets(db, 'devops');
    setPageWidgets(db, 'productivity', []);
    expect(getPageWidgets(db, 'devops')).toEqual(before);
  });

  it('accepts a widget id the registry does not know', () => {
    // Placement is user state; the store does not police the registry. A row naming an
    // unregistered widget is ignored where it is rendered, not refused where it is written.
    const result = setPageWidgets(db, 'home', [
      { widgetId: 'not-a-real-widget', order: 0, cols: 1, rows: 1 },
    ]);
    expect(result).toHaveLength(1);
  });
});
