import { describe, it, expect, beforeEach } from 'vitest';
import type { PageWidget } from '@dashboard/shared';
import { resolvePlacements, clearLegacyLayoutKeys } from './layout';
import type { WidgetMeta } from './widgets';

// A local fixture rather than the real registry: importing a *value* from `widgets.ts` pulls in
// `.svelte` components, and the web vitest config runs without the Svelte plugin (see the note
// on `resolvePlacements` and the same constraint in `nav-utils.ts`).
const registry: WidgetMeta[] = [
  { id: 'pomodoro', title: 'Pomodoro Timer', description: 'Focus timer.', route: '/widgets/pomodoro' },
  { id: 'diary', title: 'Diary', description: 'Daily journal entries.', route: '/widgets/diary' },
  { id: 'habit-log', title: 'Habit Log', description: 'Track daily habits.', route: '/widgets/habit-log' },
  { id: 'devops-agent', title: 'Agent', description: 'Robot fleet.', route: '/devops/agent-dashboard' },
];

function placement(widgetId: string, order = 0): PageWidget {
  return { widgetId, order, cols: 1, rows: 1 };
}

describe('resolvePlacements', () => {
  it('pairs a placement with its registered widget', () => {
    const [resolved] = resolvePlacements([placement('diary')], registry);
    expect(resolved.widget.id).toBe('diary');
    expect(resolved.widget.title).toBe('Diary');
  });

  it('preserves the given order', () => {
    const resolved = resolvePlacements(
      [placement('pomodoro', 0), placement('diary', 1), placement('habit-log', 2)],
      registry,
    );
    expect(resolved.map((r) => r.widget.id)).toEqual(['pomodoro', 'diary', 'habit-log']);
  });

  it('drops a placement naming a widget the registry no longer has', () => {
    // A row outlives the code that made it — deleting a widget from the registry must not
    // break every page it was ever placed on.
    const resolved = resolvePlacements([placement('diary'), placement('deleted-widget')], registry);
    expect(resolved.map((r) => r.widget.id)).toEqual(['diary']);
  });

  it('resolves a Dev Ops summary like any other widget', () => {
    // D-071 deleted `system: true`; these are ordinary library citizens now.
    expect(resolvePlacements([placement('devops-agent')], registry)).toHaveLength(1);
  });

  it('returns nothing for an empty page', () => {
    expect(resolvePlacements([], registry)).toEqual([]);
  });
});

describe('clearLegacyLayoutKeys', () => {
  // Lightweight localStorage mock for the Node/vitest environment (no DOM), matching the one
  // this file carried before PD-334 — plus `length`/`key`, which the Storage API exposes and
  // the sweep relies on.
  const store: Record<string, string> = {};

  function installStorage() {
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        get length() {
          return Object.keys(store).length;
        },
        key: (i: number) => Object.keys(store)[i] ?? null,
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
  }

  beforeEach(() => {
    Object.keys(store).forEach((k) => delete store[k]);
    installStorage();
  });

  it('removes every dashboard:layout: key', () => {
    localStorage.setItem('dashboard:layout:home', '[]');
    localStorage.setItem('dashboard:layout:productivity', '[]');

    clearLegacyLayoutKeys();

    expect(localStorage.getItem('dashboard:layout:home')).toBeNull();
    expect(localStorage.getItem('dashboard:layout:productivity')).toBeNull();
  });

  it('removes every key even though removal reindexes the store', () => {
    // The bug a naive `for (i = 0; i < length; i++) removeItem(key(i))` walks straight into.
    for (const id of ['home', 'productivity', 'devops', 'event-tracker']) {
      localStorage.setItem(`dashboard:layout:${id}`, '[]');
    }

    clearLegacyLayoutKeys();

    expect(localStorage.length).toBe(0);
  });

  it('leaves unrelated keys alone', () => {
    localStorage.setItem('theme', 'dark');
    localStorage.setItem('task-monitor:hidden-lanes', '[]');
    localStorage.setItem('dashboard:layout:home', '[]');

    clearLegacyLayoutKeys();

    expect(localStorage.getItem('theme')).toBe('dark');
    expect(localStorage.getItem('task-monitor:hidden-lanes')).toBe('[]');
    expect(localStorage.getItem('dashboard:layout:home')).toBeNull();
  });

  it('does not throw when localStorage is unavailable', () => {
    // Private mode / storage disabled: reaching for `localStorage` at all throws, which is the
    // realistic failure — not a storage object that reports zero keys.
    Object.defineProperty(globalThis, 'localStorage', {
      get() {
        throw new Error('denied');
      },
      configurable: true,
    });
    expect(() => clearLegacyLayoutKeys()).not.toThrow();
  });
});
