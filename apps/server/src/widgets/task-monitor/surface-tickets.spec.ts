import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { bootstrapSchema } from './schema';
import { registerRoutes } from './routes';
import { listTicketEvents } from './store';
import { composeSurfaceTicket, WIDGET_INBOX_SOURCE, WIDGET_INBOX_TITLE } from './surface-tickets';

function freshSetup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrapSchema(db);
  const app = Fastify({ logger: false });
  registerRoutes(app, db);
  return { app, db };
}

const widget = {
  kind: 'widget' as const,
  widgetId: 'acute-strategies-generator',
  widgetTitle: 'Acute Strategies',
  route: '/widgets/acute-strategies-generator',
};
const pageSurface = { kind: 'page' as const, pageTitle: 'Productivity', route: '/productivity' };
const appSurface = { kind: 'app' as const };

function post(
  app: ReturnType<typeof Fastify>,
  payload: Record<string, unknown>,
  path = 'surface-tickets',
) {
  return app.inject({ method: 'POST', url: `/api/widgets/task-monitor/${path}`, payload });
}

describe('composeSurfaceTicket', () => {
  it('titles from the first non-empty line, prefixed with the widget name', () => {
    const { title, body } = composeSurfaceTicket({
      surface: widget,
      text: '\n  Bigger add button  \nmore detail',
    });
    expect(title).toBe('[Acute Strategies] Bigger add button');
    expect(body.startsWith('Bigger add button  \nmore detail')).toBe(true);
    expect(body).toContain('widget id `acute-strategies-generator`');
    expect(body).toContain('`/widgets/acute-strategies-generator`');
  });

  it('prefixes page tickets with the page title and names the route', () => {
    const { title, body } = composeSurfaceTicket({
      surface: pageSurface,
      text: 'Two columns on desktop',
    });
    expect(title).toBe('[Productivity] Two columns on desktop');
    expect(body).toContain('**Productivity** page (`/productivity`)');
  });

  it('prefixes app tickets with [Shell]', () => {
    const { title, body } = composeSurfaceTicket({ surface: appSurface, text: 'Global search' });
    expect(title).toBe('[Shell] Global search');
    expect(body).toContain('dashboard as a whole');
  });

  it('truncates a long first line with an ellipsis', () => {
    const { title } = composeSurfaceTicket({ surface: widget, text: 'x'.repeat(300) });
    expect(title.length).toBeLessThanOrEqual(90);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('POST /api/widgets/task-monitor/surface-tickets', () => {
  it('files backlog tickets for every scope into one triage-inbox Epic', async () => {
    const { app, db } = freshSetup();
    const a = await post(app, { surface: widget, text: 'first' });
    const b = await post(app, { surface: pageSurface, text: 'second' });
    const c = await post(app, { surface: appSurface, text: 'third' });
    for (const r of [a, b, c]) expect(r.statusCode).toBe(201);
    const [ta, tb, tc] = [a, b, c].map((r) => r.json().ticket);
    expect(ta.status).toBe('backlog');
    expect(ta.assignee).toBeNull();
    expect(ta.source).toBe('widget:acute-strategies-generator');
    expect(tb.source).toBe('page:/productivity');
    expect(tc.source).toBe('app');
    expect(ta.epicId).not.toBeNull();
    expect(tb.epicId).toBe(ta.epicId);
    expect(tc.epicId).toBe(ta.epicId);
    expect(a.json().refineStarted).toBe(false);

    const epic = db
      .prepare('SELECT title, source, is_epic FROM agent_tickets WHERE id = ?')
      .get(ta.epicId) as { title: string; source: string; is_epic: number };
    expect(epic).toEqual({ title: WIDGET_INBOX_TITLE, source: WIDGET_INBOX_SOURCE, is_epic: 1 });
  });

  it('opens a Refine session when refine is true', async () => {
    const { app, db } = freshSetup();
    const res = await post(app, { surface: pageSurface, text: 'grill me on this', refine: true });
    expect(res.statusCode).toBe(201);
    expect(res.json().refineStarted).toBe(true);
    const events = listTicketEvents(db, res.json().ticket.id);
    expect(events.some((e) => e.type === 'refine_human')).toBe(true);
  });

  it('rejects empty text and malformed surfaces', async () => {
    const { app } = freshSetup();
    expect((await post(app, { surface: widget, text: '   ' })).json().code).toBe('INVALID_TEXT');
    expect(
      (await post(app, { surface: { ...widget, widgetId: 'Not OK' }, text: 'x' })).json().code,
    ).toBe('INVALID_SURFACE');
    expect(
      (
        await post(app, { surface: { kind: 'page', pageTitle: 'P', route: 'nope' }, text: 'x' })
      ).json().code,
    ).toBe('INVALID_SURFACE');
    expect((await post(app, { surface: { kind: 'elsewhere' }, text: 'x' })).json().code).toBe(
      'INVALID_SURFACE',
    );
    expect((await post(app, { text: 'x' })).json().code).toBe('INVALID_SURFACE');
  });
});

describe('POST /api/widgets/task-monitor/widget-tickets (legacy PD-734 shape)', () => {
  it('still files a widget ticket from the flat body', async () => {
    const { app } = freshSetup();
    const { kind: _kind, ...flat } = widget;
    const res = await post(app, { ...flat, text: 'from an old tab' }, 'widget-tickets');
    expect(res.statusCode).toBe(201);
    expect(res.json().ticket.source).toBe('widget:acute-strategies-generator');
  });
});
