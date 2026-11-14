import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { bootstrapSchema } from './schema';
import { registerRoutes } from './routes';
import { listTicketEvents } from './store';
import { composeWidgetTicket, WIDGET_INBOX_SOURCE, WIDGET_INBOX_TITLE } from './widget-tickets';

function freshSetup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrapSchema(db);
  const app = Fastify({ logger: false });
  registerRoutes(app, db);
  return { app, db };
}

const widget = {
  widgetId: 'acute-strategies-generator',
  widgetTitle: 'Acute Strategies',
  route: '/widgets/acute-strategies-generator',
};

function post(app: ReturnType<typeof Fastify>, payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/api/widgets/task-monitor/widget-tickets', payload });
}

describe('composeWidgetTicket', () => {
  it('titles from the first non-empty line, prefixed with the widget name', () => {
    const { title, body } = composeWidgetTicket({ ...widget, text: '\n  Bigger add button  \nmore detail' });
    expect(title).toBe('[Acute Strategies] Bigger add button');
    expect(body.startsWith('Bigger add button  \nmore detail')).toBe(true);
    expect(body).toContain('widget id `acute-strategies-generator`');
    expect(body).toContain('`/widgets/acute-strategies-generator`');
  });

  it('truncates a long first line with an ellipsis', () => {
    const { title } = composeWidgetTicket({ ...widget, text: 'x'.repeat(300) });
    expect(title.length).toBeLessThanOrEqual(90);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('POST /api/widgets/task-monitor/widget-tickets', () => {
  it('files a backlog ticket in the triage-inbox Epic, reusing the Epic', async () => {
    const { app, db } = freshSetup();
    const a = await post(app, { ...widget, text: 'first' });
    const b = await post(app, { ...widget, text: 'second' });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    const ta = a.json().ticket;
    const tb = b.json().ticket;
    expect(ta.status).toBe('backlog');
    expect(ta.assignee).toBeNull();
    expect(ta.source).toBe('widget:acute-strategies-generator');
    expect(ta.epicId).not.toBeNull();
    expect(tb.epicId).toBe(ta.epicId);
    expect(a.json().refineStarted).toBe(false);

    const epic = db
      .prepare('SELECT title, source, is_epic FROM agent_tickets WHERE id = ?')
      .get(ta.epicId) as { title: string; source: string; is_epic: number };
    expect(epic).toEqual({ title: WIDGET_INBOX_TITLE, source: WIDGET_INBOX_SOURCE, is_epic: 1 });
  });

  it('opens a Refine session when refine is true', async () => {
    const { app, db } = freshSetup();
    const res = await post(app, { ...widget, text: 'grill me on this', refine: true });
    expect(res.statusCode).toBe(201);
    expect(res.json().refineStarted).toBe(true);
    const events = listTicketEvents(db, res.json().ticket.id);
    expect(events.some((e) => e.type === 'refine_human')).toBe(true);
  });

  it('rejects empty text and a malformed widget', async () => {
    const { app } = freshSetup();
    expect((await post(app, { ...widget, text: '   ' })).json().code).toBe('INVALID_TEXT');
    expect((await post(app, { ...widget, widgetId: 'Not OK', text: 'x' })).json().code).toBe('INVALID_WIDGET');
  });
});
