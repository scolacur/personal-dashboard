import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import type { HabitItemView, HabitSchedule, HabitSettings, HabitTodayView } from '@dashboard/shared';
import { bootstrapHabitsSchema } from './habits';
import { registerHabitRoutes } from './habits-routes';

let db: Database.Database;
let app: FastifyInstance;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrapHabitsSchema(db);
  app = Fastify({ logger: false });
  registerHabitRoutes(app, db);
});

async function create(name: string): Promise<HabitItemView> {
  const res = await app.inject({ method: 'POST', url: '/api/habits/items', payload: { name } });
  expect(res.statusCode).toBe(201);
  return res.json() as HabitItemView;
}

describe('item routes', () => {
  it('creates, lists and renames items', async () => {
    const gym = await create('Gym');
    await create('Floss');

    const list = await app.inject({ method: 'GET', url: '/api/habits/items' });
    expect((list.json() as { items: HabitItemView[] }).items.map((i) => i.name)).toEqual(['Gym', 'Floss']);

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/habits/items/${gym.id}`,
      payload: { name: 'Workout' },
    });
    expect((renamed.json() as HabitItemView).name).toBe('Workout');
  });

  it('rejects an empty name with 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/habits/items', payload: { name: '' } });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('invalid_name');
  });

  it('404s renaming a missing item', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/habits/items/999', payload: { name: 'X' } });
    expect(res.statusCode).toBe(404);
  });

  it('reorders via the collection route without being shadowed by :id', async () => {
    const a = await create('A');
    const b = await create('B');
    const c = await create('C');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/habits/items/reorder',
      payload: { ids: [c.id, a.id, b.id] },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { items: HabitItemView[] }).items.map((i) => i.name)).toEqual(['C', 'A', 'B']);
  });

  it('moves an item into a set and rejects a cycle (PD-723)', async () => {
    const mr = await create('Morning Routine');
    const vitamins = await create('Vitamins');

    const nested = await app.inject({
      method: 'PUT',
      url: `/api/habits/items/${vitamins.id}/move`,
      payload: { parentId: mr.id, siblingIds: [vitamins.id] },
    });
    expect(nested.statusCode).toBe(200);
    const items = (nested.json() as { items: HabitItemView[] }).items;
    expect(items.find((i) => i.id === vitamins.id)!.parentId).toBe(mr.id);

    // Nesting the parent under its own child closes a cycle → 400.
    const cycle = await app.inject({
      method: 'PUT',
      url: `/api/habits/items/${mr.id}/move`,
      payload: { parentId: vitamins.id, siblingIds: [mr.id] },
    });
    expect(cycle.statusCode).toBe(400);
    expect((cycle.json() as { code: string }).code).toBe('cycle');

    // Move it back out to the top level.
    const out = await app.inject({
      method: 'PUT',
      url: `/api/habits/items/${vitamins.id}/move`,
      payload: { parentId: null, siblingIds: [mr.id, vitamins.id] },
    });
    expect(out.statusCode).toBe(200);
    expect(
      (out.json() as { items: HabitItemView[] }).items.find((i) => i.id === vitamins.id)!.parentId,
    ).toBeNull();
  });

  it('404s moving a missing item', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/habits/items/999/move', payload: { parentId: null } });
    expect(res.statusCode).toBe(404);
  });

  it('archives and restores an item', async () => {
    const gym = await create('Gym');
    await app.inject({ method: 'POST', url: `/api/habits/items/${gym.id}/archive` });
    let active = await app.inject({ method: 'GET', url: '/api/habits/items' });
    expect((active.json() as { items: HabitItemView[] }).items).toHaveLength(0);

    await app.inject({
      method: 'POST',
      url: `/api/habits/items/${gym.id}/archive`,
      payload: { archived: false },
    });
    active = await app.inject({ method: 'GET', url: '/api/habits/items' });
    expect((active.json() as { items: HabitItemView[] }).items).toHaveLength(1);
  });

  it('deletes an item and returns the completion count', async () => {
    const gym = await create('Gym');
    await app.inject({
      method: 'PUT',
      url: '/api/habits/completions',
      payload: { itemId: gym.id, day: '2026-11-16', done: true },
    });
    const res = await app.inject({ method: 'DELETE', url: `/api/habits/items/${gym.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ completionCount: 1 });
  });
});

describe('completion routes', () => {
  it('PUT is idempotent set-state', async () => {
    const gym = await create('Gym');
    const put = (done: boolean) =>
      app.inject({
        method: 'PUT',
        url: '/api/habits/completions',
        payload: { itemId: gym.id, day: '2026-11-16', done },
      });

    await put(true);
    await put(true); // replay
    const range = await app.inject({
      method: 'GET',
      url: '/api/habits/completions?from=2026-11-16&to=2026-11-16',
    });
    expect((range.json() as { completions: unknown[] }).completions).toHaveLength(1);

    const off = await put(false);
    expect(off.json()).toEqual({ completion: null });
  });

  it('404s a completion for a missing item', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/habits/completions',
      payload: { itemId: 999, day: '2026-11-16', done: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it('400s a bad day on the range read', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/habits/completions?from=nope&to=nope' });
    expect(res.statusCode).toBe(400);
  });
});

describe('schedule routes (PD-722, D-095)', () => {
  it('sets a schedule effective today and lists it', async () => {
    const gym = await create('Gym');
    const put = await app.inject({
      method: 'PUT',
      url: `/api/habits/items/${gym.id}/schedule`,
      payload: { kind: 'days_of_week', daysMask: 21 }, // Mon, Wed, Fri
    });
    expect(put.statusCode).toBe(200);
    const saved = put.json() as HabitSchedule;
    expect(saved).toMatchObject({ itemId: gym.id, kind: 'days_of_week', daysMask: 21 });
    expect(saved.effectiveFromDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const list = await app.inject({ method: 'GET', url: '/api/habits/schedules' });
    expect((list.json() as { schedules: HabitSchedule[] }).schedules).toHaveLength(1);
  });

  it('400s a bad schedule and 404s a missing item', async () => {
    const gym = await create('Gym');
    const bad = await app.inject({
      method: 'PUT',
      url: `/api/habits/items/${gym.id}/schedule`,
      payload: { kind: 'days_of_week', daysMask: 0 },
    });
    expect(bad.statusCode).toBe(400);

    const missing = await app.inject({
      method: 'PUT',
      url: '/api/habits/items/999/schedule',
      payload: { kind: 'per_week', perWeekN: 3 },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('today route (PD-722, D-095)', () => {
  it('returns a day and a row per active item', async () => {
    const gym = await create('Gym');
    const res = await app.inject({ method: 'GET', url: '/api/habits/today' });
    expect(res.statusCode).toBe(200);
    const view = res.json() as HabitTodayView;
    expect(view.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(view.rows.map((r) => r.item.id)).toEqual([gym.id]);
    expect(view.rows[0].due).toBe(true); // unscheduled → daily
    expect(view.rows[0].streak).toEqual({ current: expect.any(Number), longest: expect.any(Number) });
  });
});

describe('metric routes (PD-724)', () => {
  async function createMetric(name: string, metricType: 'time' | 'number' | 'choice'): Promise<HabitItemView> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/habits/items',
      payload: { name, kind: 'metric', metricType },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as HabitItemView;
  }

  it('PUTs a value (set-state) and clears it with null', async () => {
    const drinks = await createMetric('Drinks', 'number');
    const set = await app.inject({
      method: 'PUT',
      url: '/api/habits/metric-values',
      payload: { itemId: drinks.id, day: '2026-11-20', value: '0' },
    });
    expect(set.statusCode).toBe(200);
    expect((set.json() as { value: { value: string } }).value.value).toBe('0');

    const cleared = await app.inject({
      method: 'PUT',
      url: '/api/habits/metric-values',
      payload: { itemId: drinks.id, day: '2026-11-20', value: null },
    });
    expect((cleared.json() as { value: unknown }).value).toBeNull();
  });

  it('refuses a type change once the metric has a value (400 metric_type_locked)', async () => {
    const drinks = await createMetric('Drinks', 'number');
    await app.inject({
      method: 'PUT',
      url: '/api/habits/metric-values',
      payload: { itemId: drinks.id, day: '2026-11-20', value: '2' },
    });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/habits/items/${drinks.id}/metric-type`,
      payload: { metricType: 'time' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('metric_type_locked');
  });

  it('runs choice options through CRUD and the Today view', async () => {
    const drugs = await createMetric('Drugs', 'choice');
    const weed = await app.inject({
      method: 'POST',
      url: `/api/habits/items/${drugs.id}/options`,
      payload: { label: 'weed' },
    });
    expect(weed.statusCode).toBe(201);
    const weedId = (weed.json() as { id: number }).id;

    const list = await app.inject({ method: 'GET', url: `/api/habits/items/${drugs.id}/options` });
    expect((list.json() as { options: { label: string }[] }).options.map((o) => o.label)).toEqual(['weed']);

    const today = await app.inject({ method: 'GET', url: '/api/habits/today' });
    const view = today.json() as HabitTodayView;
    const drugsMetric = view.metrics.find((m) => m.item.id === drugs.id)!;
    expect(drugsMetric.options.map((o) => o.id)).toEqual([weedId]);

    const del = await app.inject({ method: 'DELETE', url: `/api/habits/options/${weedId}` });
    expect(del.statusCode).toBe(200);
  });
});

describe('settings routes', () => {
  it('reads defaults and patches', async () => {
    const got = await app.inject({ method: 'GET', url: '/api/habits/settings' });
    expect(got.json()).toEqual({ dayBoundaryMinutes: 240, timezone: 'America/New_York' });

    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/habits/settings',
      payload: { dayBoundaryMinutes: 300 },
    });
    expect((patched.json() as HabitSettings).dayBoundaryMinutes).toBe(300);

    const bad = await app.inject({
      method: 'PATCH',
      url: '/api/habits/settings',
      payload: { timezone: 'Mars/Phobos' },
    });
    expect(bad.statusCode).toBe(400);
  });
});
