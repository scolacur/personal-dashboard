import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { bootstrapSchema } from './schema';
import { registerRoutes, type TaskMonitorRouteDeps } from './routes';
import { createNotification, createTicket, getProjectBySlug, markTicketRefined } from './store';

function freshSetup(deps?: TaskMonitorRouteDeps) {
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

/**
 * An Epic in `slug`'s project, created once per DB and reused.
 *
 * PD-542 made "every Ticket belongs to an Epic" a create-time rule at the route layer, so fixtures
 * that only care about status/assignee/GitHub behaviour still need a parent to exist. Created
 * through the store rather than the route, because the guard being tested lives on the route and a
 * fixture should not have to satisfy it to set up an unrelated case.
 */
const epicCache = new WeakMap<Database.Database, number>();
function anEpic(db: Database.Database, pid: number): number {
  const hit = epicCache.get(db);
  if (hit !== undefined) return hit;
  const epic = createTicket(db, { title: 'fixture epic', projectId: pid, isEpic: true });
  epicCache.set(db, epic.id);
  return epic.id;
}

function projectId(db: Database.Database, slug: string): number {
  const p = getProjectBySlug(db, slug);
  if (!p) throw new Error(`no project ${slug}`);
  return p.id;
}

describe('projects routes (PD-284 slice 3)', () => {
  const PROJECTS = '/api/widgets/task-monitor/projects';

  it('POST creates a project with a prefix (key) and repo', async () => {
    const { app } = freshSetup();
    const res = await app.inject({
      method: 'POST',
      url: PROJECTS,
      payload: { slug: 'widget-foo', name: 'Widget Foo', key: 'WF', githubRepo: 'steve/widget-foo' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.key).toBe('WF');
    expect(body.githubRepo).toBe('steve/widget-foo');
    expect(body.auditEnabled).toBe(true);
  });

  it('POST requires a key', async () => {
    const { app } = freshSetup();
    const res = await app.inject({
      method: 'POST',
      url: PROJECTS,
      payload: { slug: 'no-key', name: 'No Key', githubRepo: 'o/r' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_KEY');
  });

  it('POST requires a githubRepo', async () => {
    const { app } = freshSetup();
    const res = await app.inject({
      method: 'POST',
      url: PROJECTS,
      payload: { slug: 'no-repo', name: 'No Repo', key: 'NR' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_GITHUB_REPO');
  });

  it('PATCH toggles auditEnabled', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');

    const off = await app.inject({
      method: 'PATCH',
      url: `${PROJECTS}/${pid}`,
      payload: { auditEnabled: false },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().auditEnabled).toBe(false);

    const on = await app.inject({
      method: 'PATCH',
      url: `${PROJECTS}/${pid}`,
      payload: { auditEnabled: true },
    });
    expect(on.json().auditEnabled).toBe(true);
  });

  it('PATCH rejects a non-boolean auditEnabled', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const res = await app.inject({
      method: 'PATCH',
      url: `${PROJECTS}/${pid}`,
      payload: { auditEnabled: 'yes' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_AUDIT_ENABLED');
  });

  it('PATCH 404s an unknown project', async () => {
    const { app } = freshSetup();
    const res = await app.inject({
      method: 'PATCH',
      url: `${PROJECTS}/9999`,
      payload: { auditEnabled: false },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('UNKNOWN_PROJECT');
  });
});

describe('POST /api/widgets/task-monitor/tickets — status', () => {
  it('defaults to backlog when status is omitted', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const res = await app.inject({
      method: 'POST',
      url: '/api/widgets/task-monitor/tickets',
      payload: { title: 'test', projectId: pid, epicId: anEpic(db, pid) },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('backlog');
  });

  it('respects an explicit status on create', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const res = await app.inject({
      method: 'POST',
      url: '/api/widgets/task-monitor/tickets',
      payload: { title: 'test', projectId: pid, epicId: anEpic(db, pid), status: 'backlog' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('backlog');
  });

  it('accepts closed status on create', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const res = await app.inject({
      method: 'POST',
      url: '/api/widgets/task-monitor/tickets',
      payload: { title: 'test', projectId: pid, epicId: anEpic(db, pid), status: 'closed' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('closed');
  });

  it('rejects an invalid status with 400 and INVALID_STATUS code', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const res = await app.inject({
      method: 'POST',
      url: '/api/widgets/task-monitor/tickets',
      payload: { title: 'test', projectId: pid, epicId: anEpic(db, pid), status: 'banana' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_STATUS');
  });

  it('accepts closed as a valid status', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const res = await app.inject({
      method: 'POST',
      url: '/api/widgets/task-monitor/tickets',
      payload: { title: 'cancelled', projectId: pid, epicId: anEpic(db, pid), status: 'closed' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('closed');
  });
});

describe('PATCH /api/widgets/task-monitor/tickets/:id — status closed', () => {
  it('can patch a ticket status to closed', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const create = await app.inject({
      method: 'POST',
      url: '/api/widgets/task-monitor/tickets',
      payload: { title: 'test', projectId: pid, epicId: anEpic(db, pid) },
    });
    const id: number = create.json().id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/widgets/task-monitor/tickets/${id}`,
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
      url: '/api/widgets/task-monitor/tickets',
      payload: { title: 'test', projectId: pid, epicId: anEpic(db, pid) },
    });
    const id: number = create.json().id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/widgets/task-monitor/tickets/${id}`,
      payload: { status: 'banana' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_STATUS');
  });
});

describe('POST /api/widgets/task-monitor/tickets — assignee', () => {
  it('defaults to null when assignee is omitted', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const res = await app.inject({
      method: 'POST',
      url: '/api/widgets/task-monitor/tickets',
      payload: { title: 'test', projectId: pid, epicId: anEpic(db, pid) },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().assignee).toBeNull();
  });

  it('accepts explicit robot assignee on create', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const res = await app.inject({
      method: 'POST',
      url: '/api/widgets/task-monitor/tickets',
      payload: { title: 'test', projectId: pid, epicId: anEpic(db, pid), assignee: 'robot' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().assignee).toBe('robot');
  });

  it('accepts null assignee on create', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const res = await app.inject({
      method: 'POST',
      url: '/api/widgets/task-monitor/tickets',
      payload: { title: 'test', projectId: pid, epicId: anEpic(db, pid), assignee: null },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().assignee).toBeNull();
  });

  it('rejects invalid assignee with 400 and INVALID_ASSIGNEE code', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const res = await app.inject({
      method: 'POST',
      url: '/api/widgets/task-monitor/tickets',
      payload: { title: 'test', projectId: pid, epicId: anEpic(db, pid), assignee: 'bob' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_ASSIGNEE');
  });
});

describe('PATCH /api/widgets/task-monitor/tickets/:id — assignee', () => {
  it('can patch assignee null → robot → null and round-trips on GET', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const create = await app.inject({
      method: 'POST',
      url: '/api/widgets/task-monitor/tickets',
      payload: { title: 'test', projectId: pid, epicId: anEpic(db, pid) },
    });
    const id: number = create.json().id;

    const toRobot = await app.inject({
      method: 'PATCH',
      url: `/api/widgets/task-monitor/tickets/${id}`,
      payload: { assignee: 'robot' },
    });
    expect(toRobot.statusCode).toBe(200);
    expect(toRobot.json().assignee).toBe('robot');

    const toNull = await app.inject({
      method: 'PATCH',
      url: `/api/widgets/task-monitor/tickets/${id}`,
      payload: { assignee: null },
    });
    expect(toNull.statusCode).toBe(200);
    expect(toNull.json().assignee).toBeNull();

    const list = await app.inject({ method: 'GET', url: '/api/widgets/task-monitor/tickets' });
    const ticket = list.json().find((t: { id: number }) => t.id === id);
    expect(ticket.assignee).toBeNull();
  });

  it('rejects invalid assignee on patch with 400 and INVALID_ASSIGNEE code', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const create = await app.inject({
      method: 'POST',
      url: '/api/widgets/task-monitor/tickets',
      payload: { title: 'test', projectId: pid, epicId: anEpic(db, pid) },
    });
    const id: number = create.json().id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/widgets/task-monitor/tickets/${id}`,
      payload: { assignee: 'bob' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_ASSIGNEE');
  });
});

describe('PATCH — a body edit to a refined ticket must state the choice (D-097)', () => {
  async function refinedTicket(app: ReturnType<typeof freshSetup>['app'], db: Database.Database, body: string) {
    const pid = projectId(db, 'personal-dashboard');
    const create = await app.inject({
      method: 'POST',
      url: '/api/widgets/task-monitor/tickets',
      payload: { title: 'refineme', projectId: pid, epicId: anEpic(db, pid), body },
    });
    const id: number = create.json().id;
    markTicketRefined(db, id);
    return id;
  }

  const patch = (app: ReturnType<typeof freshSetup>['app'], id: number, payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: `/api/widgets/task-monitor/tickets/${id}`, payload });

  it('refuses a body-changing patch without `refined` — 409 REFINED_CHOICE_REQUIRED', async () => {
    const { app, db } = freshSetup();
    const id = await refinedTicket(app, db, 'original');
    const res = await patch(app, id, { body: 'changed' });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('REFINED_CHOICE_REQUIRED');
  });

  it('keeps refined when refined:true is passed', async () => {
    const { app, db } = freshSetup();
    const id = await refinedTicket(app, db, 'original');
    const res = await patch(app, id, { body: 'changed', refined: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().refined).toBe(true);
  });

  it('clears refined when refined:false is passed', async () => {
    const { app, db } = freshSetup();
    const id = await refinedTicket(app, db, 'original');
    const res = await patch(app, id, { body: 'changed', refined: false });
    expect(res.statusCode).toBe(200);
    expect(res.json().refined).toBe(false);
  });

  it('does not 409 on a byte-identical body', async () => {
    const { app, db } = freshSetup();
    const id = await refinedTicket(app, db, 'same');
    const res = await patch(app, id, { body: 'same' });
    expect(res.statusCode).toBe(200);
    expect(res.json().refined).toBe(true);
  });

  it('does not 409 for a non-refined ticket', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const create = await app.inject({
      method: 'POST',
      url: '/api/widgets/task-monitor/tickets',
      payload: { title: 'plain', projectId: pid, epicId: anEpic(db, pid), body: 'b1' },
    });
    const res = await patch(app, create.json().id, { body: 'b2' });
    expect(res.statusCode).toBe(200);
  });

  it('does not 409 on a non-body edit of a refined ticket', async () => {
    const { app, db } = freshSetup();
    const id = await refinedTicket(app, db, 'original');
    const res = await patch(app, id, { title: 'renamed' });
    expect(res.statusCode).toBe(200);
    expect(res.json().refined).toBe(true);
  });
});

describe('DELETE /api/widgets/task-monitor/tickets/:id — close-on-delete (PD-207 A)', () => {
  async function makeLinkedTicket(app: ReturnType<typeof freshSetup>['app'], db: Database.Database, issue: number) {
    const pid = projectId(db, 'personal-dashboard'); // seeded with a github_repo
    const create = await app.inject({
      method: 'POST',
      url: '/api/widgets/task-monitor/tickets',
      payload: { title: 'linked', projectId: pid, epicId: anEpic(db, pid) },
    });
    const id: number = create.json().id;
    await app.inject({
      method: 'PATCH',
      url: `/api/widgets/task-monitor/tickets/${id}`,
      payload: { githubIssueNumber: issue, githubIssueUrl: `https://x/${issue}` },
    });
    return id;
  }

  it('closes the linked issue as not_planned when archiving a linked ticket', async () => {
    const { impl, calls } = recordingFetch('ok');
    const { app, db } = freshSetup({ githubWriteToken: 'wtok', fetchImpl: impl });
    const id = await makeLinkedTicket(app, db, 42);

    const del = await app.inject({ method: 'DELETE', url: `/api/widgets/task-monitor/tickets/${id}` });
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
      url: '/api/widgets/task-monitor/tickets',
      payload: { title: 'unlinked', projectId: pid, epicId: anEpic(db, pid) },
    });
    const id: number = create.json().id;

    const del = await app.inject({ method: 'DELETE', url: `/api/widgets/task-monitor/tickets/${id}` });
    expect(del.statusCode).toBe(204);
    expect(calls).toHaveLength(0);
  });

  it('does not call GitHub when no write token is configured', async () => {
    const { impl, calls } = recordingFetch('ok');
    const { app, db } = freshSetup({ fetchImpl: impl }); // no githubWriteToken
    const id = await makeLinkedTicket(app, db, 43);

    const del = await app.inject({ method: 'DELETE', url: `/api/widgets/task-monitor/tickets/${id}` });
    expect(del.statusCode).toBe(204);
    expect(calls.some((c) => /\/issues\/43$/.test(c.url) && c.method === 'PATCH')).toBe(false);
  });

  it('still returns 204 when the GitHub close throws', async () => {
    const { impl } = recordingFetch('throw');
    const { app, db } = freshSetup({ githubWriteToken: 'wtok', fetchImpl: impl });
    const id = await makeLinkedTicket(app, db, 99);

    const del = await app.inject({ method: 'DELETE', url: `/api/widgets/task-monitor/tickets/${id}` });
    expect(del.statusCode).toBe(204);
  });

  it('still returns 204 when GitHub responds non-ok', async () => {
    const { impl } = recordingFetch('notok');
    const { app, db } = freshSetup({ githubWriteToken: 'wtok', fetchImpl: impl });
    const id = await makeLinkedTicket(app, db, 77);

    const del = await app.inject({ method: 'DELETE', url: `/api/widgets/task-monitor/tickets/${id}` });
    expect(del.statusCode).toBe(204);
  });

  it('returns 404 for a non-existent ticket and never calls GitHub', async () => {
    const { impl, calls } = recordingFetch('ok');
    const { app } = freshSetup({ githubWriteToken: 'wtok', fetchImpl: impl });
    const del = await app.inject({ method: 'DELETE', url: '/api/widgets/task-monitor/tickets/99999' });
    expect(del.statusCode).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe('notifications endpoints (PD-250)', () => {
  const NBASE = '/api/widgets/task-monitor/notifications';

  it('lists notifications, filters unread, and reports the unread count', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const t = db
      .prepare(
        "INSERT INTO agent_tickets (title, status, priority, project_id, source, created_at, updated_at) VALUES ('x','queue','none',?, 'manual', 1, 1)",
      )
      .run(pid);
    const ticketId = Number(t.lastInsertRowid);
    const n1 = createNotification(db, { kind: 'agent_awaiting_human', ticketId, title: 'a' })!;
    createNotification(db, { kind: 'agent_needs_human', ticketId, title: 'b' });

    const all = await app.inject({ method: 'GET', url: NBASE });
    expect(all.json()).toHaveLength(2);
    expect(all.json()[0].title).toBe('b'); // newest first

    const count = await app.inject({ method: 'GET', url: `${NBASE}/unread-count` });
    expect(count.json().count).toBe(2);

    const capped = await app.inject({ method: 'GET', url: `${NBASE}?limit=1` });
    expect(capped.json()).toHaveLength(1);

    const read = await app.inject({ method: 'POST', url: `${NBASE}/${n1.id}/read` });
    expect(read.statusCode).toBe(204);

    const unread = await app.inject({ method: 'GET', url: `${NBASE}?unread=1` });
    expect(unread.json()).toHaveLength(1);
    expect(unread.json()[0].title).toBe('b');
  });

  it('404s marking a missing notification read; read-all reports the count', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const t = db
      .prepare(
        "INSERT INTO agent_tickets (title, status, priority, project_id, source, created_at, updated_at) VALUES ('x','queue','none',?, 'manual', 1, 1)",
      )
      .run(pid);
    createNotification(db, { kind: 'agent_awaiting_human', ticketId: Number(t.lastInsertRowid), title: 'a' });

    const missing = await app.inject({ method: 'POST', url: `${NBASE}/9999/read` });
    expect(missing.statusCode).toBe(404);

    const all = await app.inject({ method: 'POST', url: `${NBASE}/read-all` });
    expect(all.json().marked).toBe(1);
  });
});

describe('POST /tickets/:id/reply (PD-250 inline reply)', () => {
  async function linkedTicket(app: ReturnType<typeof freshSetup>['app'], db: Database.Database, issue: number) {
    const pid = projectId(db, 'personal-dashboard');
    const create = await app.inject({
      method: 'POST',
      url: '/api/widgets/task-monitor/tickets',
      payload: { title: 'parked', projectId: pid, epicId: anEpic(db, pid) },
    });
    const id: number = create.json().id;
    await app.inject({
      method: 'PATCH',
      url: `/api/widgets/task-monitor/tickets/${id}`,
      payload: { githubIssueNumber: issue, githubIssueUrl: `https://x/${issue}` },
    });
    return id;
  }

  // C5/PD-346: the inline reply is now DB-native — it records a robot_human_reply event (the loop's
  // resume signal) and returns 201, then best-effort mirrors to any linked GitHub issue. A missing
  // issue/token or a GitHub failure no longer fails the reply.
  function replyEvent(db: Database.Database, id: number): { detail: string } | undefined {
    return db
      .prepare("SELECT detail FROM agent_ticket_events WHERE ticket_id = ? AND type = 'robot_human_reply'")
      .get(id) as { detail: string } | undefined;
  }

  it('records a robot_human_reply event and mirrors a marked comment when linked + token present', async () => {
    const { impl, calls } = recordingFetch('ok');
    const { app, db } = freshSetup({ githubWriteToken: 'wtok', fetchImpl: impl });
    const id = await linkedTicket(app, db, 55);

    const res = await app.inject({
      method: 'POST',
      url: `/api/widgets/task-monitor/tickets/${id}/reply`,
      payload: { body: 'go with blue' },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(replyEvent(db, id)!.detail)).toMatchObject({ text: 'go with blue' });
    const post = calls.find((c) => c.method === 'POST' && /\/issues\/55\/comments$/.test(c.url));
    expect(post).toBeDefined();
    expect((post!.body as { body: string }).body).toContain('go with blue');
    expect((post!.body as { body: string }).body).toContain('<!-- robot:human-reply -->');
  });

  it('rejects an empty body with 400', async () => {
    const { impl } = recordingFetch('ok');
    const { app, db } = freshSetup({ githubWriteToken: 'wtok', fetchImpl: impl });
    const id = await linkedTicket(app, db, 56);
    const res = await app.inject({
      method: 'POST',
      url: `/api/widgets/task-monitor/tickets/${id}/reply`,
      payload: { body: '   ' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('still records the reply (201) when the ticket has no linked issue — DB-native, no GitHub needed', async () => {
    const { impl } = recordingFetch('ok');
    const { app, db } = freshSetup({ githubWriteToken: 'wtok', fetchImpl: impl });
    const pid = projectId(db, 'personal-dashboard');
    const create = await app.inject({
      method: 'POST',
      url: '/api/widgets/task-monitor/tickets',
      payload: { title: 'unlinked', projectId: pid, epicId: anEpic(db, pid) },
    });
    const id: number = create.json().id;
    const res = await app.inject({
      method: 'POST',
      url: `/api/widgets/task-monitor/tickets/${id}/reply`,
      payload: { body: 'hi' },
    });
    expect(res.statusCode).toBe(201);
    expect(replyEvent(db, id)).toBeDefined();
  });

  it('still records the reply (201) when no write token is configured', async () => {
    const { impl } = recordingFetch('ok');
    const { app, db } = freshSetup({ fetchImpl: impl }); // no token
    const id = await linkedTicket(app, db, 57);
    const res = await app.inject({
      method: 'POST',
      url: `/api/widgets/task-monitor/tickets/${id}/reply`,
      payload: { body: 'hi' },
    });
    expect(res.statusCode).toBe(201);
    expect(replyEvent(db, id)).toBeDefined();
  });

  it('still records the reply (201) even if the GitHub mirror is rejected', async () => {
    const { impl } = recordingFetch('notok');
    const { app, db } = freshSetup({ githubWriteToken: 'wtok', fetchImpl: impl });
    const id = await linkedTicket(app, db, 58);
    const res = await app.inject({
      method: 'POST',
      url: `/api/widgets/task-monitor/tickets/${id}/reply`,
      payload: { body: 'hi' },
    });
    expect(res.statusCode).toBe(201);
    expect(replyEvent(db, id)).toBeDefined();
  });

  it('404s for an unknown ticket', async () => {
    const { impl } = recordingFetch('ok');
    const { app } = freshSetup({ githubWriteToken: 'wtok', fetchImpl: impl });
    const res = await app.inject({
      method: 'POST',
      url: `/api/widgets/task-monitor/tickets/999999/reply`,
      payload: { body: 'hi' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('ticket events + Refine reply (D-044, PD-267)', () => {
  const base = '/api/widgets/task-monitor';

  async function makeTicket(app: ReturnType<typeof freshSetup>['app'], db: Database.Database, pid: number): Promise<number> {
    const res = await app.inject({ method: 'POST', url: `${base}/tickets`, payload: { title: 't', projectId: pid, epicId: anEpic(db, pid) } });
    return res.json().id as number;
  }

  it('GET /tickets/:id/events returns the activity log (created event present)', async () => {
    const { app, db } = freshSetup();
    const id = await makeTicket(app, db, projectId(db, 'personal-dashboard'));
    const res = await app.inject({ method: 'GET', url: `${base}/tickets/${id}/events` });
    expect(res.statusCode).toBe(200);
    const events = res.json() as { type: string }[];
    expect(events.some((e) => e.type === 'created')).toBe(true);
  });

  it('GET /tickets/:id/events 400s on a non-numeric id', async () => {
    const { app } = freshSetup();
    const res = await app.inject({ method: 'GET', url: `${base}/tickets/abc/events` });
    expect(res.statusCode).toBe(400);
  });

  it('GET /tickets/:id returns the single ticket; 404 unknown; 400 bad id', async () => {
    const { app, db } = freshSetup();
    const id = await makeTicket(app, db, projectId(db, 'personal-dashboard'));
    const ok = await app.inject({ method: 'GET', url: `${base}/tickets/${id}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().id).toBe(id);
    expect((await app.inject({ method: 'GET', url: `${base}/tickets/9999` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `${base}/tickets/abc` })).statusCode).toBe(400);
  });

  it('POST /tickets/:id/refine-reply writes a refine_human event and echoes it', async () => {
    const { app, db } = freshSetup();
    const id = await makeTicket(app, db, projectId(db, 'personal-dashboard'));
    const res = await app.inject({
      method: 'POST',
      url: `${base}/tickets/${id}/refine-reply`,
      payload: { body: 'only the header, please' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().type).toBe('refine_human');
    const events = (await app.inject({ method: 'GET', url: `${base}/tickets/${id}/events` })).json() as {
      type: string;
    }[];
    expect(events.filter((e) => e.type === 'refine_human')).toHaveLength(1);
  });

  it('POST /tickets/:id/refine-reply 400s on an empty body', async () => {
    const { app, db } = freshSetup();
    const id = await makeTicket(app, db, projectId(db, 'personal-dashboard'));
    const res = await app.inject({ method: 'POST', url: `${base}/tickets/${id}/refine-reply`, payload: { body: '  ' } });
    expect(res.statusCode).toBe(400);
  });

  it('POST /tickets/:id/refine-reply 404s for an unknown ticket', async () => {
    const { app } = freshSetup();
    const res = await app.inject({ method: 'POST', url: `${base}/tickets/9999/refine-reply`, payload: { body: 'hi' } });
    expect(res.statusCode).toBe(404);
  });

  // PD-744: structured answers to the open question round.
  it('POST /tickets/:id/refine-reply with answers 201s on the open round; 409 with none; 400 invalid', async () => {
    const { app, db } = freshSetup();
    const id = await makeTicket(app, db, projectId(db, 'personal-dashboard'));
    const answers = [{ questionId: 'q1', choice: 1 }];
    const none = await app.inject({ method: 'POST', url: `${base}/tickets/${id}/refine-reply`, payload: { answers } });
    expect(none.statusCode).toBe(409);
    expect(none.json().code).toBe('NO_OPEN_ROUND');

    const round = {
      questions: [
        {
          id: 'q1',
          question: 'Which?',
          why: 'It decides the split.',
          options: [
            { label: 'A', description: 'one ticket' },
            { label: 'B', description: 'three tickets' },
          ],
          recommended: 0,
        },
      ],
      assumptions: [],
    };
    db.prepare('INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)').run(
      id,
      'refine_agent',
      JSON.stringify({ text: 'q', sessionId: 's', round }),
      Date.now() - 1000,
    );
    const bad = await app.inject({
      method: 'POST',
      url: `${base}/tickets/${id}/refine-reply`,
      payload: { answers: [{ questionId: 'q1', choice: 7 }] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('INVALID_ANSWERS');
    expect((await app.inject({ method: 'POST', url: `${base}/tickets/${id}/refine-reply`, payload: { answers: 'x' } })).statusCode).toBe(400);

    const ok = await app.inject({ method: 'POST', url: `${base}/tickets/${id}/refine-reply`, payload: { answers } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().type).toBe('refine_human');
    expect(ok.json().detail.text).toContain('→ B: three tickets');
  });

  it('PD-889: answering a stale round 409s with ROUND_STALE', async () => {
    const { app, db } = freshSetup();
    const id = await makeTicket(app, db, projectId(db, 'personal-dashboard'));
    const round = {
      questions: [
        {
          id: 'q1',
          question: 'Which?',
          why: 'It decides the split.',
          options: [
            { label: 'A', description: 'one' },
            { label: 'B', description: 'three' },
          ],
          recommended: 0,
        },
      ],
      assumptions: [],
    };
    db.prepare('INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)').run(
      id,
      'refine_agent',
      JSON.stringify({ text: 'q', sessionId: 's', round }),
      Date.now() - 2000,
    );
    // A cited ticket changed → the server appended a stale turn as the newest Refine-state event.
    db.prepare('INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)').run(
      id,
      'refine_round_stale',
      JSON.stringify({ text: 'PD-9 changed', changedTicketId: 9, changedDisplayId: 'PD-9', change: 'closed', invalidates: 'round' }),
      Date.now() - 1000,
    );
    const res = await app.inject({
      method: 'POST',
      url: `${base}/tickets/${id}/refine-reply`,
      payload: { answers: [{ questionId: 'q1', choice: 0 }] },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('ROUND_STALE');
  });

  // PD-746: the Decisions inbox.
  it('GET /refine/awaiting returns the waiting sessions and their count', async () => {
    const { app, db } = freshSetup();
    const empty = (await app.inject({ method: 'GET', url: `${base}/refine/awaiting` })).json();
    expect(empty).toEqual({ items: [], count: 0 });
    const id = await makeTicket(app, db, projectId(db, 'personal-dashboard'));
    db.prepare('INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)').run(
      id,
      'refine_agent',
      JSON.stringify({ text: 'a question' }),
      Date.now() - 1000,
    );
    const res = (await app.inject({ method: 'GET', url: `${base}/refine/awaiting` })).json();
    expect(res.count).toBe(1);
    expect(res.items[0].ticketId).toBe(id);
    expect(res.items[0].agentText).toBe('a question');
  });

  // PD-748: the Epic backfill switch.
  it('POST /tickets/:id/backfill-exclude toggles an Epic; 400 on a non-Epic or a bad body', async () => {
    const { app, db } = freshSetup();
    const pd = projectId(db, 'personal-dashboard');
    const epic = await app.inject({ method: 'POST', url: `${base}/tickets`, payload: { title: 'E', projectId: pd, isEpic: true } });
    const epicId = epic.json().id as number;
    const on = await app.inject({ method: 'POST', url: `${base}/tickets/${epicId}/backfill-exclude`, payload: { excluded: true } });
    expect(on.statusCode).toBe(200);
    expect(on.json().backfillExcluded).toBe(true);
    const bad = await app.inject({ method: 'POST', url: `${base}/tickets/${epicId}/backfill-exclude`, payload: { excluded: 'yes' } });
    expect(bad.statusCode).toBe(400);
    const id = await makeTicket(app, db, pd);
    const notEpic = await app.inject({ method: 'POST', url: `${base}/tickets/${id}/backfill-exclude`, payload: { excluded: true } });
    expect(notEpic.statusCode).toBe(400);
    expect(notEpic.json().code).toBe('NOT_EPIC');
  });

  // PD-743: end a Refine session with no commit.
  it('POST /tickets/:id/refine-park 201s with the refine_parked event, then 409s ALREADY_ENDED', async () => {
    const { app, db } = freshSetup();
    const id = await makeTicket(app, db, projectId(db, 'personal-dashboard'));
    await app.inject({ method: 'POST', url: `${base}/tickets/${id}/refine-reply`, payload: { body: 'start' } });
    const res = await app.inject({ method: 'POST', url: `${base}/tickets/${id}/refine-park` });
    expect(res.statusCode).toBe(201);
    expect(res.json().type).toBe('refine_parked');
    const ticket = (await app.inject({ method: 'GET', url: `${base}/tickets/${id}` })).json();
    expect(ticket.refineState).toBeNull();
    const again = await app.inject({ method: 'POST', url: `${base}/tickets/${id}/refine-park` });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('ALREADY_ENDED');
  });

  it('POST /tickets/:id/refine-park 409s NO_SESSION without a thread; 404 unknown; 400 bad id', async () => {
    const { app, db } = freshSetup();
    const id = await makeTicket(app, db, projectId(db, 'personal-dashboard'));
    const none = await app.inject({ method: 'POST', url: `${base}/tickets/${id}/refine-park` });
    expect(none.statusCode).toBe(409);
    expect(none.json().code).toBe('NO_SESSION');
    expect((await app.inject({ method: 'POST', url: `${base}/tickets/9999/refine-park` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `${base}/tickets/abc/refine-park` })).statusCode).toBe(400);
  });
});

describe('POST /tickets/:id/refine — start a Refine session (D-044, PD-268)', () => {
  const base = '/api/widgets/task-monitor';

  async function makeTicket(app: ReturnType<typeof freshSetup>['app'], db: Database.Database, pid: number, title = 't', body?: string) {
    const res = await app.inject({ method: 'POST', url: `${base}/tickets`, payload: { title, body, projectId: pid, epicId: anEpic(db, pid) } });
    return res.json().id as number;
  }

  it('writes the kickoff refine_human event and 201s', async () => {
    const { app, db } = freshSetup();
    const id = await makeTicket(app, db, projectId(db, 'personal-dashboard'), 'Add widget', 'shows X');
    const res = await app.inject({ method: 'POST', url: `${base}/tickets/${id}/refine` });
    expect(res.statusCode).toBe(201);
    expect(res.json().type).toBe('refine_human');
    const events = (await app.inject({ method: 'GET', url: `${base}/tickets/${id}/events` })).json() as {
      type: string;
    }[];
    expect(events.filter((e) => e.type === 'refine_human')).toHaveLength(1);
  });

  it('409s on a double-start (no second thread)', async () => {
    const { app, db } = freshSetup();
    const id = await makeTicket(app, db, projectId(db, 'personal-dashboard'));
    expect((await app.inject({ method: 'POST', url: `${base}/tickets/${id}/refine` })).statusCode).toBe(201);
    const again = await app.inject({ method: 'POST', url: `${base}/tickets/${id}/refine` });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('ALREADY_STARTED');
  });

  it('404s for an unknown ticket', async () => {
    const { app } = freshSetup();
    const res = await app.inject({ method: 'POST', url: `${base}/tickets/9999/refine` });
    expect(res.statusCode).toBe(404);
  });

  it('reflects refineState in the tickets list after starting', async () => {
    const { app, db } = freshSetup();
    const id = await makeTicket(app, db, projectId(db, 'personal-dashboard'));
    await app.inject({ method: 'POST', url: `${base}/tickets/${id}/refine` });
    const tickets = (await app.inject({ method: 'GET', url: `${base}/tickets` })).json() as {
      id: number;
      refineState: string | null;
    }[];
    expect(tickets.find((t) => t.id === id)?.refineState).toBe('refining');
  });
});

describe('Refine commit endpoints (D-044, PD-269)', () => {
  const base = '/api/widgets/task-monitor';
  const ROBOT_BODY = '## Context\nc\n## Task\nt\n## Done When\nd\n## Out of scope\no';

  async function makeTicket(app: ReturnType<typeof freshSetup>['app'], db: Database.Database, pid: number, status = 'backlog') {
    const res = await app.inject({
      method: 'POST',
      url: `${base}/tickets`,
      payload: { title: 't', body: 'b', projectId: pid, epicId: anEpic(db, pid), status },
    });
    return res.json().id as number;
  }
  function seedProposal(db: Database.Database, ticketId: number, proposal: unknown) {
    db.prepare(
      'INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)',
    ).run(ticketId, 'refine_proposal', JSON.stringify(proposal), Date.now());
  }

  it('POST /refine-approve executes a decompose (201) and lineage reflects the split', async () => {
    const { app, db } = freshSetup();
    const id = await makeTicket(app, db, projectId(db, 'personal-dashboard'));
    seedProposal(db, id, {
      mode: 'decompose',
      children: [{ title: 'robot', body: ROBOT_BODY, status: 'queue', assignee: 'robot' }],
    });
    const res = await app.inject({ method: 'POST', url: `${base}/tickets/${id}/refine-approve` });
    expect(res.statusCode).toBe(201);
    // GET /relations is now the full resolved list (D-048); the parent's "split into" lineage is
    // its outgoing (direction 'from') split relations, and the decompose writes them origin='agent'.
    const rels = (await app.inject({ method: 'GET', url: `${base}/tickets/${id}/relations` })).json();
    const splitInto = rels.filter(
      (r: { type: string; direction: string }) => r.type === 'split' && r.direction === 'from',
    );
    expect(splitInto).toHaveLength(1);
    expect(splitInto[0].origin).toBe('agent');
  });

  it('POST /refine-approve parks an unshaped robot child instead of rejecting (201, D-057)', async () => {
    const { app, db } = freshSetup();
    const id = await makeTicket(app, db, projectId(db, 'personal-dashboard'));
    seedProposal(db, id, {
      mode: 'decompose',
      children: [{ title: 'bad', body: 'no sections', status: 'queue', assignee: 'robot' }],
    });
    const res = await app.inject({ method: 'POST', url: `${base}/tickets/${id}/refine-approve` });
    expect(res.statusCode).toBe(201);
    expect(res.json().queued).toBe(false);
  });

  it('POST /refine-approve { queue: true } dispatches a refine_in_place into queue (201)', async () => {
    const { app, db } = freshSetup();
    const id = await makeTicket(app, db, projectId(db, 'personal-dashboard'));
    seedProposal(db, id, { mode: 'refine_in_place', body: ROBOT_BODY, status: 'backlog' });
    const res = await app.inject({
      method: 'POST',
      url: `${base}/tickets/${id}/refine-approve`,
      payload: { queue: true },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().queued).toBe(true);
    const ticket = (await app.inject({ method: 'GET', url: `${base}/tickets/${id}` })).json();
    expect(ticket.status).toBe('queue');
  });

  it('POST /refine-approve { queue: true } on an Epic is 409 EPIC_NOT_QUEUEABLE, not 500 (PD-377)', async () => {
    const { app, db } = freshSetup();
    const res0 = await app.inject({
      method: 'POST',
      url: `${base}/tickets`,
      payload: { title: 'epic', body: 'b', projectId: projectId(db, 'personal-dashboard'), status: 'backlog', isEpic: true },
    });
    const id = res0.json().id as number;
    seedProposal(db, id, { mode: 'refine_in_place', body: ROBOT_BODY, status: 'backlog' });
    const res = await app.inject({
      method: 'POST',
      url: `${base}/tickets/${id}/refine-approve`,
      payload: { queue: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('EPIC_NOT_QUEUEABLE');
  });

  it('POST /refine-approve 409s with no proposal', async () => {
    const { app, db } = freshSetup();
    const id = await makeTicket(app, db, projectId(db, 'personal-dashboard'));
    const res = await app.inject({ method: 'POST', url: `${base}/tickets/${id}/refine-approve` });
    expect(res.statusCode).toBe(409);
  });

  it('POST /refine-reject 201s and drops the proposal', async () => {
    const { app, db } = freshSetup();
    const id = await makeTicket(app, db, projectId(db, 'personal-dashboard'));
    seedProposal(db, id, { mode: 'refine_in_place', body: 'x' });
    expect((await app.inject({ method: 'POST', url: `${base}/tickets/${id}/refine-reject` })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: `${base}/tickets/${id}/refine-approve` })).statusCode).toBe(409);
  });

  it('GET /relations 400s on a bad id', async () => {
    const { app } = freshSetup();
    expect((await app.inject({ method: 'GET', url: `${base}/tickets/abc/relations` })).statusCode).toBe(400);
  });
});

describe('Ticket Audit routes (PD-283)', () => {
  const base = '/api/widgets/task-monitor';

  it('POST /audit/runs enqueues a run (202, created), and coalesces the second call', async () => {
    const { app } = freshSetup();
    const first = await app.inject({ method: 'POST', url: `${base}/audit/runs` });
    expect(first.statusCode).toBe(202);
    expect(first.json().created).toBe(true);

    const second = await app.inject({ method: 'POST', url: `${base}/audit/runs` });
    expect(second.statusCode).toBe(202);
    expect(second.json().created).toBe(false);
    expect(second.json().run.id).toBe(first.json().run.id);
  });

  it('GET /audit/runs lists runs newest-first', async () => {
    const { app } = freshSetup();
    await app.inject({ method: 'POST', url: `${base}/audit/runs` });
    const res = await app.inject({ method: 'GET', url: `${base}/audit/runs` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    expect(res.json()[0].status).toBe('requested');
  });

  it('GET /audit/runs/:id/findings returns {run, findings}; 404 unknown; 400 bad id', async () => {
    const { app } = freshSetup();
    const runId = (await app.inject({ method: 'POST', url: `${base}/audit/runs` })).json().run.id;
    const ok = await app.inject({ method: 'GET', url: `${base}/audit/runs/${runId}/findings` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().run.id).toBe(runId);
    expect(ok.json().findings).toEqual([]);
    expect((await app.inject({ method: 'GET', url: `${base}/audit/runs/9999/findings` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `${base}/audit/runs/abc/findings` })).statusCode).toBe(400);
  });
});

describe('ticket relations endpoints (D-048, PD-321)', () => {
  const B = '/api/widgets/task-monitor';
  async function mk(app: ReturnType<typeof freshSetup>['app'], db: Database.Database, pid: number, title: string) {
    const res = await app.inject({ method: 'POST', url: `${B}/tickets`, payload: { title, projectId: pid, epicId: anEpic(db, pid) } });
    return res.json();
  }

  it('POST creates a human relation; GET /relations returns it resolved with origin', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const a = await mk(app, db, pid, 'a');
    const b = await mk(app, db, pid, 'b');
    // "a blocked by b" → from=b (blocker), to=a (blocked)
    const created = await app.inject({
      method: 'POST',
      url: `${B}/tickets/${a.id}/relations`,
      payload: { fromId: b.id, toId: a.id, type: 'blocks' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().origin).toBe('human');
    expect(created.json().type).toBe('blocks');

    const all = await app.inject({ method: 'GET', url: `${B}/tickets/${a.id}/relations` });
    expect(all.statusCode).toBe(200);
    const rels = all.json();
    expect(rels).toHaveLength(1);
    expect(rels[0].direction).toBe('to'); // a is the blocked (to) end
    expect(rels[0].other.ticketId).toBe(b.id);
    expect(rels[0].origin).toBe('human');
  });

  it('POST rejects self-relation (400) and cycle (409)', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const a = await mk(app, db, pid, 'a');
    const b = await mk(app, db, pid, 'b');
    const self = await app.inject({
      method: 'POST',
      url: `${B}/tickets/${a.id}/relations`,
      payload: { fromId: a.id, toId: a.id, type: 'blocks' },
    });
    expect(self.statusCode).toBe(400);
    expect(self.json().code).toBe('SELF_RELATION');

    await app.inject({
      method: 'POST',
      url: `${B}/tickets/${a.id}/relations`,
      payload: { fromId: b.id, toId: a.id, type: 'blocks' },
    });
    const cycle = await app.inject({
      method: 'POST',
      url: `${B}/tickets/${b.id}/relations`,
      payload: { fromId: a.id, toId: b.id, type: 'blocks' },
    });
    expect(cycle.statusCode).toBe(409);
    expect(cycle.json().code).toBe('RELATION_CYCLE');
    expect(Array.isArray(cycle.json().path)).toBe(true);
  });

  it('POST validates type, id membership, and ticket existence', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const a = await mk(app, db, pid, 'a');
    const b = await mk(app, db, pid, 'b');
    const badType = await app.inject({
      method: 'POST',
      url: `${B}/tickets/${a.id}/relations`,
      payload: { fromId: a.id, toId: b.id, type: 'nope' },
    });
    expect(badType.statusCode).toBe(400);
    const mismatch = await app.inject({
      method: 'POST',
      url: `${B}/tickets/${a.id}/relations`,
      payload: { fromId: b.id, toId: b.id, type: 'relates' },
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().code).toBe('ID_MISMATCH');
    const missing = await app.inject({
      method: 'POST',
      url: `${B}/tickets/${a.id}/relations`,
      payload: { fromId: a.id, toId: 99999, type: 'relates' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('DELETE removes a relation by id (204) then 404', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const a = await mk(app, db, pid, 'a');
    const b = await mk(app, db, pid, 'b');
    const created = await app.inject({
      method: 'POST',
      url: `${B}/tickets/${a.id}/relations`,
      payload: { fromId: a.id, toId: b.id, type: 'relates' },
    });
    const relId = created.json().id;
    const del = await app.inject({ method: 'DELETE', url: `${B}/tickets/${a.id}/relations/${relId}` });
    expect(del.statusCode).toBe(204);
    const again = await app.inject({ method: 'DELETE', url: `${B}/tickets/${a.id}/relations/${relId}` });
    expect(again.statusCode).toBe(404);
  });

  it('PATCH to queue succeeds even while blocked (D-051 amended, PD-408 — loop skips at selection)', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const a = await mk(app, db, pid, 'a');
    const blocker = await mk(app, db, pid, 'blocker');
    await app.inject({
      method: 'POST',
      url: `${B}/tickets/${a.id}/relations`,
      payload: { fromId: blocker.id, toId: a.id, type: 'blocks' },
    });
    // Queue entry is no longer refused for a blocked ticket — it sits in the queue, de-emphasized.
    const blocked = await app.inject({
      method: 'PATCH',
      url: `${B}/tickets/${a.id}`,
      payload: { status: 'queue' },
    });
    expect(blocked.statusCode).toBe(200);
    expect(blocked.json().status).toBe('queue');
  });

  it('GET /relations returns the full resolved list including split (PD-269 lineage derivable)', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const parent = await mk(app, db, pid, 'parent');
    const child = await mk(app, db, pid, 'child');
    await app.inject({
      method: 'POST',
      url: `${B}/tickets/${parent.id}/relations`,
      payload: { fromId: parent.id, toId: child.id, type: 'split' },
    });
    const res = await app.inject({ method: 'GET', url: `${B}/tickets/${parent.id}/relations` });
    expect(res.statusCode).toBe(200);
    const rels = res.json();
    expect(rels).toHaveLength(1);
    // parent is the `from` end of the split → its "split into" lineage is direction 'from'.
    expect(rels[0].type).toBe('split');
    expect(rels[0].direction).toBe('from');
    expect(rels[0].other.ticketId).toBe(child.id);
    // 404 on a missing ticket.
    expect((await app.inject({ method: 'GET', url: `${B}/tickets/99999/relations` })).statusCode).toBe(404);
  });
});

/**
 * PD-542 — the queue-model rules hold against a raw call, not just against the board.
 *
 * These go through `app.inject`, i.e. the same path a `curl` takes, because the whole point of the
 * ticket is that the board was the only thing enforcing them.
 */
describe('PD-542 — queue-model invariants at the HTTP boundary', () => {
  /** A project that uses the Epic model, plus one Epic and one member in it. */
  async function withEpic(app: ReturnType<typeof freshSetup>['app'], db: Database.Database) {
    const pid = projectId(db, 'personal-dashboard');
    const epic = await app.inject({
      method: 'POST',
      url: '/api/widgets/task-monitor/tickets',
      payload: { title: 'umbrella', projectId: pid, isEpic: true },
    });
    const epicId = epic.json().id as number;
    const member = await app.inject({
      method: 'POST',
      url: '/api/widgets/task-monitor/tickets',
      payload: { title: 'member', projectId: pid, epicId },
    });
    return { pid, epicId, memberId: member.json().id as number };
  }

  it('refuses a create with no Epic, in every project', async () => {
    const { app, db } = freshSetup();
    const { pid } = await withEpic(app, db);
    const res = await app.inject({
      method: 'POST',
      url: '/api/widgets/task-monitor/tickets',
      payload: { title: 'orphan', projectId: pid },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('EPIC_REQUIRED');
  });

  it('refuses to un-parent an active member', async () => {
    const { app, db } = freshSetup();
    const { memberId } = await withEpic(app, db);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/widgets/task-monitor/tickets/${memberId}`,
      payload: { epicId: null },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('EPIC_REQUIRED');
  });

  it('refuses to un-complete a Ticket with a plain PATCH, and points at reopen', async () => {
    const { app, db } = freshSetup();
    const { memberId } = await withEpic(app, db);
    await app.inject({
      method: 'PATCH',
      url: `/api/widgets/task-monitor/tickets/${memberId}`,
      payload: { status: 'completed' },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/widgets/task-monitor/tickets/${memberId}`,
      payload: { status: 'backlog' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('TERMINAL_IS_FINAL');
    expect(res.json().error).toMatch(/reopen/i);
  });

  it('refuses to edit a completed Ticket', async () => {
    const { app, db } = freshSetup();
    const { memberId } = await withEpic(app, db);
    await app.inject({
      method: 'PATCH',
      url: `/api/widgets/task-monitor/tickets/${memberId}`,
      payload: { status: 'completed' },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/widgets/task-monitor/tickets/${memberId}`,
      payload: { title: 'rewriting history' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('TERMINAL_IS_READ_ONLY');
  });

  it('reopens through the dedicated route, back to backlog', async () => {
    const { app, db } = freshSetup();
    const { memberId } = await withEpic(app, db);
    await app.inject({
      method: 'PATCH',
      url: `/api/widgets/task-monitor/tickets/${memberId}`,
      payload: { status: 'completed' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/widgets/task-monitor/tickets/${memberId}/reopen`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('backlog');
  });

  it('refuses to reopen a Ticket that is not terminal', async () => {
    const { app, db } = freshSetup();
    const { memberId } = await withEpic(app, db);
    const res = await app.inject({
      method: 'POST',
      url: `/api/widgets/task-monitor/tickets/${memberId}/reopen`,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('NOT_TERMINAL');
  });
});

describe('maxTurns over HTTP (PD-432)', () => {
  it('saves a per-ticket turn budget on create and on PATCH, and clears it with null', async () => {
    const { app, db } = freshSetup();
    const pid = getProjectBySlug(db, 'personal-dashboard')!.id;
    const created = await app.inject({
      method: 'POST',
      url: '/api/widgets/task-monitor/tickets',
      payload: { title: 't', projectId: pid, epicId: anEpic(db, pid), maxTurns: 60 },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().maxTurns).toBe(60);
    const id = created.json().id;
    const patched = await app.inject({ method: 'PATCH', url: `/api/widgets/task-monitor/tickets/${id}`, payload: { maxTurns: 80 } });
    expect(patched.json().maxTurns).toBe(80);
    const cleared = await app.inject({ method: 'PATCH', url: `/api/widgets/task-monitor/tickets/${id}`, payload: { maxTurns: null } });
    expect(cleared.json().maxTurns).toBeNull();
  });

  it('PD-896: kind is accepted on create and PATCH, and an invalid kind is a 400 INVALID_KIND', async () => {
    const { app, db } = freshSetup();
    const pid = getProjectBySlug(db, 'personal-dashboard')!.id;
    const created = await app.inject({
      method: 'POST',
      url: '/api/widgets/task-monitor/tickets',
      payload: { title: 't', projectId: pid, epicId: anEpic(db, pid), kind: 'bug' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().kind).toBe('bug');
    const id = created.json().id;
    const patched = await app.inject({ method: 'PATCH', url: `/api/widgets/task-monitor/tickets/${id}`, payload: { kind: 'feature' } });
    expect(patched.json().kind).toBe('feature');
    const bad = await app.inject({ method: 'PATCH', url: `/api/widgets/task-monitor/tickets/${id}`, payload: { kind: 'spike' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('INVALID_KIND');
  });

  it('PD-880: coderArea is accepted on create and PATCH, and an invalid area is a 400 INVALID_CODER_AREA', async () => {
    const { app, db } = freshSetup();
    const pid = getProjectBySlug(db, 'personal-dashboard')!.id;
    const created = await app.inject({
      method: 'POST',
      url: '/api/widgets/task-monitor/tickets',
      payload: { title: 't', projectId: pid, epicId: anEpic(db, pid), coderArea: 'loop' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().coderArea).toBe('loop');
    const id = created.json().id;
    const patched = await app.inject({ method: 'PATCH', url: `/api/widgets/task-monitor/tickets/${id}`, payload: { coderArea: 'board' } });
    expect(patched.json().coderArea).toBe('board');
    const cleared = await app.inject({ method: 'PATCH', url: `/api/widgets/task-monitor/tickets/${id}`, payload: { coderArea: null } });
    expect(cleared.json().coderArea).toBeNull();
    const bad = await app.inject({ method: 'PATCH', url: `/api/widgets/task-monitor/tickets/${id}`, payload: { coderArea: 'frontend' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('INVALID_CODER_AREA');
    const badCreate = await app.inject({
      method: 'POST',
      url: '/api/widgets/task-monitor/tickets',
      payload: { title: 't2', projectId: pid, epicId: anEpic(db, pid), coderArea: 'frontend' },
    });
    expect(badCreate.statusCode).toBe(400);
    expect(badCreate.json().code).toBe('INVALID_CODER_AREA');
  });

  it('rejects an invalid budget with 400', async () => {
    const { app, db } = freshSetup();
    const pid = getProjectBySlug(db, 'personal-dashboard')!.id;
    const t = createTicket(db, { title: 't', projectId: pid, epicId: anEpic(db, pid) });
    const res = await app.inject({ method: 'PATCH', url: `/api/widgets/task-monitor/tickets/${t.id}`, payload: { maxTurns: 0 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_MAX_TURNS');
  });
});
