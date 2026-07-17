import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { bootstrapSchema } from './schema';
import { registerRoutes, type TaskMonitorRouteDeps } from './routes';
import { createNotification, getProjectBySlug } from './store';
import { __resetOnDemandSyncGuard } from './github-sync';

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

function projectId(db: Database.Database, slug: string): number {
  const p = getProjectBySlug(db, slug);
  if (!p) throw new Error(`no project ${slug}`);
  return p.id;
}

describe('POST /api/widgets/task-monitor/tickets — status', () => {
  it('defaults to backlog when status is omitted', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const res = await app.inject({
      method: 'POST',
      url: '/api/widgets/task-monitor/tickets',
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
      url: '/api/widgets/task-monitor/tickets',
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
      url: '/api/widgets/task-monitor/tickets',
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
      url: '/api/widgets/task-monitor/tickets',
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
      url: '/api/widgets/task-monitor/tickets',
      payload: { title: 'cancelled', projectId: pid, status: 'closed' },
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
      payload: { title: 'test', projectId: pid },
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
      payload: { title: 'test', projectId: pid },
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
      url: '/api/widgets/task-monitor/tickets',
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
      url: '/api/widgets/task-monitor/tickets',
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
      url: '/api/widgets/task-monitor/tickets',
      payload: { title: 'test', projectId: pid, assignee: 'bob' },
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
      payload: { title: 'test', projectId: pid },
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
      payload: { title: 'test', projectId: pid },
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

describe('DELETE /api/widgets/task-monitor/tickets/:id — close-on-delete (PD-207 A)', () => {
  async function makeLinkedTicket(app: ReturnType<typeof freshSetup>['app'], db: Database.Database, issue: number) {
    const pid = projectId(db, 'personal-dashboard'); // seeded with a github_repo
    const create = await app.inject({
      method: 'POST',
      url: '/api/widgets/task-monitor/tickets',
      payload: { title: 'linked', projectId: pid },
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
      payload: { title: 'unlinked', projectId: pid },
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
        "INSERT INTO agent_tickets (title, status, priority, project_id, source, created_at, updated_at) VALUES ('x','robot_queue','none',?, 'manual', 1, 1)",
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
        "INSERT INTO agent_tickets (title, status, priority, project_id, source, created_at, updated_at) VALUES ('x','robot_queue','none',?, 'manual', 1, 1)",
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
      payload: { title: 'parked', projectId: pid },
    });
    const id: number = create.json().id;
    await app.inject({
      method: 'PATCH',
      url: `/api/widgets/task-monitor/tickets/${id}`,
      payload: { githubIssueNumber: issue, githubIssueUrl: `https://x/${issue}` },
    });
    return id;
  }

  it('posts a marked comment via the write token and returns 201', async () => {
    const { impl, calls } = recordingFetch('ok');
    const { app, db } = freshSetup({ githubWriteToken: 'wtok', fetchImpl: impl });
    const id = await linkedTicket(app, db, 55);

    const res = await app.inject({
      method: 'POST',
      url: `/api/widgets/task-monitor/tickets/${id}/reply`,
      payload: { body: 'go with blue' },
    });
    expect(res.statusCode).toBe(201);
    const post = calls.find((c) => c.method === 'POST' && /\/issues\/55\/comments$/.test(c.url));
    expect(post).toBeDefined();
    expect((post!.body as { body: string }).body).toContain('go with blue');
    expect((post!.body as { body: string }).body).toContain('<!-- sortie:human-reply -->');
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

  it('409s when the ticket has no linked issue', async () => {
    const { impl } = recordingFetch('ok');
    const { app, db } = freshSetup({ githubWriteToken: 'wtok', fetchImpl: impl });
    const pid = projectId(db, 'personal-dashboard');
    const create = await app.inject({
      method: 'POST',
      url: '/api/widgets/task-monitor/tickets',
      payload: { title: 'unlinked', projectId: pid },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/widgets/task-monitor/tickets/${create.json().id}/reply`,
      payload: { body: 'hi' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('NO_LINKED_ISSUE');
  });

  it('503s when no write token is configured', async () => {
    const { impl } = recordingFetch('ok');
    const { app, db } = freshSetup({ fetchImpl: impl }); // no token
    const id = await linkedTicket(app, db, 57);
    const res = await app.inject({
      method: 'POST',
      url: `/api/widgets/task-monitor/tickets/${id}/reply`,
      payload: { body: 'hi' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('NO_WRITE_TOKEN');
  });

  it('502s when GitHub rejects the comment', async () => {
    const { impl } = recordingFetch('notok');
    const { app, db } = freshSetup({ githubWriteToken: 'wtok', fetchImpl: impl });
    const id = await linkedTicket(app, db, 58);
    const res = await app.inject({
      method: 'POST',
      url: `/api/widgets/task-monitor/tickets/${id}/reply`,
      payload: { body: 'hi' },
    });
    expect(res.statusCode).toBe(502);
  });
});

describe('POST /api/widgets/task-monitor/sync — on-demand GitHub reconciliation (PD-252)', () => {
  it('503s when no read token is configured', async () => {
    __resetOnDemandSyncGuard();
    const { app } = freshSetup(); // no githubReadToken, and env token not injected
    const res = await app.inject({ method: 'POST', url: '/api/widgets/task-monitor/sync' });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('NO_READ_TOKEN');
  });

  it('runs a pass when a read token is present and reports the outcome', async () => {
    __resetOnDemandSyncGuard();
    const { impl } = recordingFetch('ok');
    const { app } = freshSetup({ githubReadToken: 'read-tok', fetchImpl: impl });
    const res = await app.inject({ method: 'POST', url: '/api/widgets/task-monitor/sync' });
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe('ran');
  });

  it('throttles a second immediate call so refresh spam cannot hammer GitHub', async () => {
    __resetOnDemandSyncGuard();
    const { impl } = recordingFetch('ok');
    const { app } = freshSetup({ githubReadToken: 'read-tok', fetchImpl: impl });
    const first = await app.inject({ method: 'POST', url: '/api/widgets/task-monitor/sync' });
    const second = await app.inject({ method: 'POST', url: '/api/widgets/task-monitor/sync' });
    expect(first.json().outcome).toBe('ran');
    expect(second.json().outcome).toBe('throttled');
  });
});

describe('ticket events + Refine reply (D-044, PD-267)', () => {
  const base = '/api/widgets/task-monitor';

  async function makeTicket(app: ReturnType<typeof freshSetup>['app'], pid: number): Promise<number> {
    const res = await app.inject({ method: 'POST', url: `${base}/tickets`, payload: { title: 't', projectId: pid } });
    return res.json().id as number;
  }

  it('GET /tickets/:id/events returns the activity log (created event present)', async () => {
    const { app, db } = freshSetup();
    const id = await makeTicket(app, projectId(db, 'personal-dashboard'));
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

  it('POST /tickets/:id/refine-reply writes a refine_human event and echoes it', async () => {
    const { app, db } = freshSetup();
    const id = await makeTicket(app, projectId(db, 'personal-dashboard'));
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
    const id = await makeTicket(app, projectId(db, 'personal-dashboard'));
    const res = await app.inject({ method: 'POST', url: `${base}/tickets/${id}/refine-reply`, payload: { body: '  ' } });
    expect(res.statusCode).toBe(400);
  });

  it('POST /tickets/:id/refine-reply 404s for an unknown ticket', async () => {
    const { app } = freshSetup();
    const res = await app.inject({ method: 'POST', url: `${base}/tickets/9999/refine-reply`, payload: { body: 'hi' } });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /tickets/:id/refine — start a Refine session (D-044, PD-268)', () => {
  const base = '/api/widgets/task-monitor';

  async function makeTicket(app: ReturnType<typeof freshSetup>['app'], pid: number, title = 't', body?: string) {
    const res = await app.inject({ method: 'POST', url: `${base}/tickets`, payload: { title, body, projectId: pid } });
    return res.json().id as number;
  }

  it('writes the kickoff refine_human event and 201s', async () => {
    const { app, db } = freshSetup();
    const id = await makeTicket(app, projectId(db, 'personal-dashboard'), 'Add widget', 'shows X');
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
    const id = await makeTicket(app, projectId(db, 'personal-dashboard'));
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
    const id = await makeTicket(app, projectId(db, 'personal-dashboard'));
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
  const SORTIE_BODY = '## Context\nc\n## Task\nt\n## Done When\nd\n## Out of scope\no';

  async function makeTicket(app: ReturnType<typeof freshSetup>['app'], pid: number, status = 'prioritized') {
    const res = await app.inject({
      method: 'POST',
      url: `${base}/tickets`,
      payload: { title: 't', body: 'b', projectId: pid, status },
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
    const id = await makeTicket(app, projectId(db, 'personal-dashboard'));
    seedProposal(db, id, {
      mode: 'decompose',
      children: [{ title: 'robot', body: SORTIE_BODY, status: 'robot_queue', assignee: 'robot' }],
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

  it('POST /refine-approve 422s a non-Sortie-ready robot child', async () => {
    const { app, db } = freshSetup();
    const id = await makeTicket(app, projectId(db, 'personal-dashboard'));
    seedProposal(db, id, {
      mode: 'decompose',
      children: [{ title: 'bad', body: 'no sections', status: 'robot_queue', assignee: 'robot' }],
    });
    const res = await app.inject({ method: 'POST', url: `${base}/tickets/${id}/refine-approve` });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('NOT_SORTIE_READY');
  });

  it('POST /refine-approve 409s with no proposal', async () => {
    const { app, db } = freshSetup();
    const id = await makeTicket(app, projectId(db, 'personal-dashboard'));
    const res = await app.inject({ method: 'POST', url: `${base}/tickets/${id}/refine-approve` });
    expect(res.statusCode).toBe(409);
  });

  it('POST /refine-reject 201s and drops the proposal', async () => {
    const { app, db } = freshSetup();
    const id = await makeTicket(app, projectId(db, 'personal-dashboard'));
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
  async function mk(app: ReturnType<typeof freshSetup>['app'], pid: number, title: string) {
    const res = await app.inject({ method: 'POST', url: `${B}/tickets`, payload: { title, projectId: pid } });
    return res.json();
  }

  it('POST creates a human relation; GET /relations returns it resolved with origin', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const a = await mk(app, pid, 'a');
    const b = await mk(app, pid, 'b');
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
    const a = await mk(app, pid, 'a');
    const b = await mk(app, pid, 'b');
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
    const a = await mk(app, pid, 'a');
    const b = await mk(app, pid, 'b');
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
    const a = await mk(app, pid, 'a');
    const b = await mk(app, pid, 'b');
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

  it('PATCH to robot_queue is 409 while blocked, 200 once the blocker resolves', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const a = await mk(app, pid, 'a');
    const blocker = await mk(app, pid, 'blocker');
    await app.inject({
      method: 'POST',
      url: `${B}/tickets/${a.id}/relations`,
      payload: { fromId: blocker.id, toId: a.id, type: 'blocks' },
    });
    const blocked = await app.inject({
      method: 'PATCH',
      url: `${B}/tickets/${a.id}`,
      payload: { status: 'robot_queue' },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe('BLOCKED_BY_UNRESOLVED');
    expect(blocked.json().blockers[0].ticketId).toBe(blocker.id);

    await app.inject({ method: 'PATCH', url: `${B}/tickets/${blocker.id}`, payload: { status: 'completed' } });
    const ok = await app.inject({
      method: 'PATCH',
      url: `${B}/tickets/${a.id}`,
      payload: { status: 'robot_queue' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('robot_queue');
  });

  it('GET /relations returns the full resolved list including split (PD-269 lineage derivable)', async () => {
    const { app, db } = freshSetup();
    const pid = projectId(db, 'personal-dashboard');
    const parent = await mk(app, pid, 'parent');
    const child = await mk(app, pid, 'child');
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
