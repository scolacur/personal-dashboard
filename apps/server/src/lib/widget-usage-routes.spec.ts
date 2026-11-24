import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { bootstrapWidgetUsageSchema } from './widget-usage';
import { isValidWidgetId, registerWidgetUsageRoutes } from './widget-usage-routes';

let db: Database.Database;
let app: FastifyInstance;

beforeEach(() => {
  db = new Database(':memory:');
  bootstrapWidgetUsageSchema(db);
  app = Fastify({ logger: false });
  registerWidgetUsageRoutes(app, db);
});

const use = (id: string) => app.inject({ method: 'POST', url: `/api/shell/widget-usage/${id}` });

describe('POST /api/shell/widget-usage/:widgetId', () => {
  it('records a use and returns the row', async () => {
    const res = await use('habit-tracker');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ widgetId: 'habit-tracker', useCount: 1 });
    expect(typeof res.json().lastUsedAt).toBe('number');
  });

  it('counts repeat uses', async () => {
    await use('diary');
    const res = await use('diary');
    expect(res.json().useCount).toBe(2);
  });

  it('rejects a malformed widget id with 400 and writes nothing', async () => {
    const res = await use('Not%20A%20Widget');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'INVALID_WIDGET_ID' });
    const list = await app.inject({ method: 'GET', url: '/api/shell/widget-usage' });
    expect(list.json()).toEqual([]);
  });
});

describe('GET /api/shell/widget-usage', () => {
  it('lists usage most recent first', async () => {
    await use('a');
    // Same-millisecond writes tie on time; force a gap so the order is meaningful.
    await new Promise((r) => setTimeout(r, 5));
    await use('b');
    const res = await app.inject({ method: 'GET', url: '/api/shell/widget-usage' });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((u: { widgetId: string }) => u.widgetId)).toEqual(['b', 'a']);
  });

  it('honours limit and tolerates a junk one', async () => {
    await use('a');
    await use('b');
    const one = await app.inject({ method: 'GET', url: '/api/shell/widget-usage?limit=1' });
    expect(one.json()).toHaveLength(1);
    const junk = await app.inject({ method: 'GET', url: '/api/shell/widget-usage?limit=abc' });
    expect(junk.statusCode).toBe(200);
    expect(junk.json()).toHaveLength(2);
  });
});

describe('isValidWidgetId', () => {
  it.each(['diary', 'habit-tracker', 'devops-task-tracker', 'e2e-canary'])('accepts %s', (id) => {
    expect(isValidWidgetId(id)).toBe(true);
  });

  it.each(['', 'Diary', 'habit_tracker', '-lead', 'trail-', 'a--b', '../x', 'x'.repeat(65)])(
    'rejects %j',
    (id) => {
      expect(isValidWidgetId(id)).toBe(false);
    },
  );
});
