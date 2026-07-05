import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { bootstrapSchema } from './schema';
import { registerRoutes, type AgentDashboardRouteDeps } from './routes';
import { getProjectBySlug } from './store';

function freshSetup(deps?: AgentDashboardRouteDeps) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrapSchema(db);
  const app = Fastify({ logger: false });
  registerRoutes(app, db, deps);
  return { app, db };
}

/** A fetch that records calls and returns a configurable ok/throw. */
function recordingFetch(mode: 'ok' | 'notok' | 'throw' = 'ok') {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const impl = (async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
    if (mode === 'throw') throw new Error('network down');
    return { ok: mode === 'ok', status: mode === 'ok' ? 200 : 500, json: async () => ({}) };
  }) as unknown as typeof fetch;
  return { impl, calls };
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
      payload: { title: 'test', projectId: pid, status: 'prioritized' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('prioritized');
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

describe('DELETE /api/widgets/agent-dashboard/tickets/:id — close-on-delete (PD-207 A)', () => {
  async function makeLinkedTicket(app: ReturnType<typeof freshSetup>['app'], db: Database.Database, issue: number) {
    const pid = projectId(db, 'personal-dashboard'); // seeded with a github_repo
    const create = await app.inject({
      method: 'POST',
      url: '/api/widgets/agent-dashboard/tickets',
      payload: { title: 'linked', projectId: pid },
    });
    const id: number = create.json().id;
    await app.inject({
      method: 'PATCH',
      url: `/api/widgets/agent-dashboard/tickets/${id}`,
      payload: { githubIssueNumber: issue, githubIssueUrl: `https://x/${issue}` },
    });
    return id;
  }

  it('closes the linked issue as not_planned when archiving a linked ticket', async () => {
    const { impl, calls } = recordingFetch('ok');
    const { app, db } = freshSetup({ githubWriteToken: 'wtok', fetchImpl: impl });
    const id = await makeLinkedTicket(app, db, 42);

    const del = await app.inject({ method: 'DELETE', url: `/api/widgets/agent-dashboard/tickets/${id}` });
    expect(del.statusCode).toBe(204);

    const patch = calls.find((c) => c.method === 'PATCH' && /\/issues\/42$/.test(c.url));
    expect(patch).toBeDefined();
    expect(patch?.body).toMatchObject({ state: 'closed', state_reason: 'not_planned' });
  });

  it('does not call GitHub when the archived ticket has no linked issue', async () => {
    const { impl, calls } = recordingFetch('ok');
    const { app, db } = freshSetup({ githubWriteToken: 'wtok', fetchImpl: impl });
    const pid = projectId(db, 'personal-dashboard');
    const create = await app.inject({
      method: 'POST',
      url: '/api/widgets/agent-dashboard/tickets',
      payload: { title: 'unlinked', projectId: pid },
    });
    const id: number = create.json().id;

    const del = await app.inject({ method: 'DELETE', url: `/api/widgets/agent-dashboard/tickets/${id}` });
    expect(del.statusCode).toBe(204);
    expect(calls).toHaveLength(0);
  });

  it('does not call GitHub when no write token is configured', async () => {
    const { impl, calls } = recordingFetch('ok');
    const { app, db } = freshSetup({ fetchImpl: impl }); // no githubWriteToken
    const id = await makeLinkedTicket(app, db, 43);

    const del = await app.inject({ method: 'DELETE', url: `/api/widgets/agent-dashboard/tickets/${id}` });
    expect(del.statusCode).toBe(204);
    expect(calls.some((c) => /\/issues\/43$/.test(c.url) && c.method === 'PATCH')).toBe(false);
  });

  it('still returns 204 when the GitHub close throws', async () => {
    const { impl } = recordingFetch('throw');
    const { app, db } = freshSetup({ githubWriteToken: 'wtok', fetchImpl: impl });
    const id = await makeLinkedTicket(app, db, 99);

    const del = await app.inject({ method: 'DELETE', url: `/api/widgets/agent-dashboard/tickets/${id}` });
    expect(del.statusCode).toBe(204);
  });

  it('still returns 204 when GitHub responds non-ok', async () => {
    const { impl } = recordingFetch('notok');
    const { app, db } = freshSetup({ githubWriteToken: 'wtok', fetchImpl: impl });
    const id = await makeLinkedTicket(app, db, 77);

    const del = await app.inject({ method: 'DELETE', url: `/api/widgets/agent-dashboard/tickets/${id}` });
    expect(del.statusCode).toBe(204);
  });

  it('returns 404 for a non-existent ticket and never calls GitHub', async () => {
    const { impl, calls } = recordingFetch('ok');
    const { app } = freshSetup({ githubWriteToken: 'wtok', fetchImpl: impl });
    const del = await app.inject({ method: 'DELETE', url: '/api/widgets/agent-dashboard/tickets/99999' });
    expect(del.statusCode).toBe(404);
    expect(calls).toHaveLength(0);
  });
});
