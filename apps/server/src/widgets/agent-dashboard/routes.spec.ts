import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { bootstrapSchema } from './schema';
import { registerRoutes } from './routes';
import { getProjectBySlug } from './store';

function freshSetup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrapSchema(db);
  const app = Fastify({ logger: false });
  registerRoutes(app, db);
  return { app, db };
}

function projectId(db: Database.Database, slug: string): number {
  const p = getProjectBySlug(db, slug);
  if (!p) throw new Error(`no project ${slug}`);
  return p.id;
}

describe('POST /api/widgets/agent-dashboard/tickets — status', () => {
  it('defaults to backlog when status is omitted', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const res = await app.inject({
      method: 'POST',
      url: '/api/widgets/agent-dashboard/tickets',
      payload: { title: 'test', projectId: pid },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('backlog');
  });

  it('respects an explicit status on create', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const res = await app.inject({
      method: 'POST',
      url: '/api/widgets/agent-dashboard/tickets',
      payload: { title: 'test', projectId: pid, status: 'ready' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('ready');
  });

  it('accepts closed status on create', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const res = await app.inject({
      method: 'POST',
      url: '/api/widgets/agent-dashboard/tickets',
      payload: { title: 'test', projectId: pid, status: 'closed' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('closed');
  });

  it('rejects an invalid status with 400 and INVALID_STATUS code', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const res = await app.inject({
      method: 'POST',
      url: '/api/widgets/agent-dashboard/tickets',
      payload: { title: 'test', projectId: pid, status: 'banana' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_STATUS');
  });

  it('accepts closed as a valid status', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const res = await app.inject({
      method: 'POST',
      url: '/api/widgets/agent-dashboard/tickets',
      payload: { title: 'cancelled', projectId: pid, status: 'closed' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('closed');
  });
});

describe('PATCH /api/widgets/agent-dashboard/tickets/:id — status closed', () => {
  it('can patch a ticket status to closed', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const create = await app.inject({
      method: 'POST',
      url: '/api/widgets/agent-dashboard/tickets',
      payload: { title: 'test', projectId: pid },
    });
    const id: number = create.json().id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/widgets/agent-dashboard/tickets/${id}`,
      payload: { status: 'closed' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('closed');
  });

  it('rejects invalid status on patch with 400 and INVALID_STATUS code', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const create = await app.inject({
      method: 'POST',
      url: '/api/widgets/agent-dashboard/tickets',
      payload: { title: 'test', projectId: pid },
    });
    const id: number = create.json().id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/widgets/agent-dashboard/tickets/${id}`,
      payload: { status: 'banana' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_STATUS');
  });
});

describe('POST /api/widgets/agent-dashboard/tickets — assignee', () => {
  it('defaults to null when assignee is omitted', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const res = await app.inject({
      method: 'POST',
      url: '/api/widgets/agent-dashboard/tickets',
      payload: { title: 'test', projectId: pid },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().assignee).toBeNull();
  });

  it('accepts explicit robot assignee on create', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const res = await app.inject({
      method: 'POST',
      url: '/api/widgets/agent-dashboard/tickets',
      payload: { title: 'test', projectId: pid, assignee: 'robot' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().assignee).toBe('robot');
  });

  it('accepts null assignee on create', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const res = await app.inject({
      method: 'POST',
      url: '/api/widgets/agent-dashboard/tickets',
      payload: { title: 'test', projectId: pid, assignee: null },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().assignee).toBeNull();
  });

  it('rejects invalid assignee with 400 and INVALID_ASSIGNEE code', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const res = await app.inject({
      method: 'POST',
      url: '/api/widgets/agent-dashboard/tickets',
      payload: { title: 'test', projectId: pid, assignee: 'bob' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_ASSIGNEE');
  });
});

describe('PATCH /api/widgets/agent-dashboard/tickets/:id — assignee', () => {
  it('can patch assignee null → robot → null and round-trips on GET', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const create = await app.inject({
      method: 'POST',
      url: '/api/widgets/agent-dashboard/tickets',
      payload: { title: 'test', projectId: pid },
    });
    const id: number = create.json().id;

    const toRobot = await app.inject({
      method: 'PATCH',
      url: `/api/widgets/agent-dashboard/tickets/${id}`,
      payload: { assignee: 'robot' },
    });
    expect(toRobot.statusCode).toBe(200);
    expect(toRobot.json().assignee).toBe('robot');

    const toNull = await app.inject({
      method: 'PATCH',
      url: `/api/widgets/agent-dashboard/tickets/${id}`,
      payload: { assignee: null },
    });
    expect(toNull.statusCode).toBe(200);
    expect(toNull.json().assignee).toBeNull();

    const list = await app.inject({ method: 'GET', url: '/api/widgets/agent-dashboard/tickets' });
    const ticket = list.json().find((t: { id: number }) => t.id === id);
    expect(ticket.assignee).toBeNull();
  });

  it('rejects invalid assignee on patch with 400 and INVALID_ASSIGNEE code', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const create = await app.inject({
      method: 'POST',
      url: '/api/widgets/agent-dashboard/tickets',
      payload: { title: 'test', projectId: pid },
    });
    const id: number = create.json().id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/widgets/agent-dashboard/tickets/${id}`,
      payload: { assignee: 'bob' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_ASSIGNEE');
  });
});
