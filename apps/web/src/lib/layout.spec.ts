import { beforeEach, describe, expect, it } from 'vitest';
import { loadPageLayout, savePageLayout, clearPageLayout, defaultLayout } from './layout';
import type { WidgetMeta } from './widgets';

// Minimal fixtures
const stub = (id: string): WidgetMeta => ({ id, title: id, description: '', route: `/${id}` });
const withEmbed = (id: string, cols: number, rows: number): WidgetMeta => ({
  id,
  title: id,
  description: '',
  route: `/${id}`,
  embed: { component: {} as never, span: { cols, rows } },
});

// Lightweight localStorage mock for the Node/vitest environment (no DOM)
const store: Record<string, string> = {};
beforeEach(() => {
  Object.keys(store).forEach((k) => delete store[k]);
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    },
    configurable: true,
    writable: true,
  });
});

describe('defaultLayout', () => {
  it('preserves registry order', () => {
    const result = defaultLayout([stub('a'), stub('b'), stub('c')]);
    expect(result.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('uses embed span for cols/rows', () => {
    const result = defaultLayout([withEmbed('x', 2, 3)]);
    expect(result[0]).toMatchObject({ id: 'x', cols: 2, rows: 3 });
  });

  it('defaults to 1x1 for stub widgets', () => {
    const result = defaultLayout([stub('y')]);
    expect(result[0]).toMatchObject({ cols: 1, rows: 1 });
  });

  it('assigns sequential order values', () => {
    const result = defaultLayout([stub('a'), stub('b')]);
    expect(result[0].order).toBe(0);
    expect(result[1].order).toBe(1);
  });
});

describe('loadPageLayout', () => {
  it('returns defaults when no saved data exists', () => {
    const result = loadPageLayout('test', [stub('a'), stub('b')]);
    expect(result.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('returns saved order when data exists', () => {
    savePageLayout('test', [
      { id: 'b', order: 0, cols: 1, rows: 1 },
      { id: 'a', order: 1, cols: 1, rows: 1 },
    ]);
    const result = loadPageLayout('test', [stub('a'), stub('b')]);
    expect(result.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('ignores stale ids that are no longer in the registry', () => {
    savePageLayout('test', [
      { id: 'stale', order: 0, cols: 1, rows: 1 },
      { id: 'a', order: 1, cols: 1, rows: 1 },
    ]);
    const result = loadPageLayout('test', [stub('a'), stub('b')]);
    expect(result.map((r) => r.id)).not.toContain('stale');
  });

  it('appends registry widgets absent from saved data at the end', () => {
    savePageLayout('test', [{ id: 'a', order: 0, cols: 1, rows: 1 }]);
    const result = loadPageLayout('test', [stub('a'), stub('b'), stub('c')]);
    expect(result.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('preserves saved cols/rows overrides', () => {
    savePageLayout('test', [{ id: 'a', order: 0, cols: 3, rows: 4 }]);
    const result = loadPageLayout('test', [stub('a')]);
    expect(result[0]).toMatchObject({ cols: 3, rows: 4 });
  });

  it('falls back to registry span for newly appended widgets', () => {
    savePageLayout('test', [{ id: 'a', order: 0, cols: 1, rows: 1 }]);
    const result = loadPageLayout('test', [stub('a'), withEmbed('b', 2, 3)]);
    const b = result.find((r) => r.id === 'b');
    expect(b).toMatchObject({ cols: 2, rows: 3 });
  });
});

describe('savePageLayout + clearPageLayout round-trip', () => {
  it('persists and reloads layout correctly', () => {
    const data = [{ id: 'a', order: 0, cols: 2, rows: 1 }];
    savePageLayout('pg', data);
    const back = loadPageLayout('pg', [stub('a')]);
    expect(back[0]).toMatchObject({ cols: 2, rows: 1 });
  });

  it('clearPageLayout reverts to registry defaults', () => {
    savePageLayout('pg', [
      { id: 'b', order: 0, cols: 1, rows: 1 },
      { id: 'a', order: 1, cols: 1, rows: 1 },
    ]);
    clearPageLayout('pg');
    const result = loadPageLayout('pg', [stub('a'), stub('b')]);
    expect(result.map((r) => r.id)).toEqual(['a', 'b']);
  });
});
