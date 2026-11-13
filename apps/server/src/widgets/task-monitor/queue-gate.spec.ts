import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { bootstrapSchema } from './schema';
import { registerRoutes } from './routes';
import { createTicket, getProjectBySlug, getTicket, listTicketEvents } from './store';

// D-091 (PD-632): a robot-assigned ticket may not enter the Queue unless it and its Epic are
// refined — enforced at every door the server owns, against a raw request.

const base = '/api/widgets/task-monitor';
const READY_BODY = '## Context\nc\n## Task\nt\n## Done When\nd\n## Out of scope\no';

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrapSchema(db);
  const app = Fastify({ logger: false });
  registerRoutes(app, db);
  const p = getProjectBySlug(db, 'personal-dashboard');
  if (!p) throw new Error('no project');
  return { app, db, pid: p.id };
}

/** Set flags directly: the fixture is not the thing under test, so it must not have to pass the gate. */
function setFlags(db: Database.Database, id: number, f: { refined?: 0 | 1; stale?: 0 | 1; status?: string; assignee?: string | null }) {
  if (f.refined !== undefined) db.prepare('UPDATE agent_tickets SET refined = ? WHERE id = ?').run(f.refined, id);
  if (f.stale !== undefined) db.prepare('UPDATE agent_tickets SET refine_stale = ? WHERE id = ?').run(f.stale, id);
  if (f.status !== undefined) db.prepare('UPDATE agent_tickets SET status = ? WHERE id = ?').run(f.status, id);
  if (f.assignee !== undefined) db.prepare('UPDATE agent_tickets SET assignee = ? WHERE id = ?').run(f.assignee, id);
}

function epicWith(db: Database.Database, pid: number, refined: 0 | 1 = 1) {
  const epic = createTicket(db, { title: 'epic', projectId: pid, isEpic: true });
  setFlags(db, epic.id, { refined });
  return epic.id;
}

/** A member of `epicId`. Adding a member to a refined Epic invalidates it (D-089) — correct, but not
 *  what these fixtures are building — so the Epic's flags are put back as they were. */
function member(db: Database.Database, pid: number, epicId: number, o: { refined?: 0 | 1; assignee?: 'robot' | 'steve' | null } = {}) {
  const before = db.prepare('SELECT refined, refine_stale FROM agent_tickets WHERE id = ?').get(epicId) as {
    refined: 0 | 1;
    refine_stale: 0 | 1;
  };
  const t = createTicket(db, {
    title: 'm',
    body: READY_BODY,
    projectId: pid,
    epicId,
    assignee: o.assignee === undefined ? 'robot' : o.assignee,
  });
  setFlags(db, t.id, { refined: o.refined ?? 1 });
  setFlags(db, epicId, { refined: before.refined, stale: before.refine_stale });
  return t.id;
}

async function patch(app: ReturnType<typeof setup>['app'], id: number, payload: Record<string, unknown>) {
  return app.inject({ method: 'PATCH', url: `${base}/tickets/${id}`, payload });
}

describe('PATCH — the Queue gate on a ticket (D-091)', () => {
  it('refuses moving an unrefined robot ticket into the Queue, returning the full blocker list', async () => {
    const { app, db, pid } = setup();
    const epic = epicWith(db, pid);
    const id = member(db, pid, epic, { refined: 0 });
    const res = await patch(app, id, { status: 'queue' });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.code).toBe('QUEUE_GATE');
    expect(body.blockers.map((c: { id: string }) => c.id)).toEqual([
      'refined',
      'epic-refined',
      'epic-not-stale',
      'members-refined',
      'ready',
      'unblocked',
    ]);
    expect(body.blockers.find((c: { id: string }) => c.id === 'refined').met).toBe(false);
    expect(getTicket(db, id)?.status).toBe('backlog');
  });

  it('refuses assigning an already-queued unrefined ticket to the Robot', async () => {
    const { app, db, pid } = setup();
    const epic = epicWith(db, pid);
    const id = member(db, pid, epic, { refined: 0, assignee: 'steve' });
    setFlags(db, id, { status: 'queue' });
    const res = await patch(app, id, { assignee: 'robot' });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('QUEUE_GATE');
    expect(getTicket(db, id)?.assignee).toBe('steve');
  });

  it('refuses a refined ticket whose Epic is not refined', async () => {
    const { app, db, pid } = setup();
    const epic = epicWith(db, pid, 0);
    const id = member(db, pid, epic);
    const res = await patch(app, id, { status: 'queue' });
    expect(res.statusCode).toBe(409);
    const unmet = res.json().blockers.filter((c: { met: boolean }) => !c.met).map((c: { id: string }) => c.id);
    expect(unmet).toEqual(['epic-refined']);
  });

  it('refuses under a stale Epic, and when a sibling is unrefined', async () => {
    const { app, db, pid } = setup();
    const stale = epicWith(db, pid);
    setFlags(db, stale, { stale: 1 });
    const a = member(db, pid, stale);
    expect((await patch(app, a, { status: 'queue' })).statusCode).toBe(409);

    const epic = epicWith(db, pid);
    const b = member(db, pid, epic);
    member(db, pid, epic, { refined: 0 });
    const res = await patch(app, b, { status: 'queue' });
    expect(res.statusCode).toBe(409);
    const unmet = res.json().blockers.filter((c: { met: boolean }) => !c.met).map((c: { id: string }) => c.id);
    expect(unmet).toEqual(['members-refined']);
  });

  it('admits a refined robot ticket under a refined Epic', async () => {
    const { app, db, pid } = setup();
    const epic = epicWith(db, pid);
    const id = member(db, pid, epic);
    const res = await patch(app, id, { status: 'queue' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('queue');
  });

  it('judges the ticket as it will be: refining and queueing in one PATCH is admitted', async () => {
    const { app, db, pid } = setup();
    const epic = epicWith(db, pid);
    const id = member(db, pid, epic, { refined: 0 });
    expect((await patch(app, id, { status: 'queue', refined: true })).statusCode).toBe(200);
  });

  it('does not refuse on Ready or blockers — those keep their own gates (D-058, D-051/PD-408)', async () => {
    const { app, db, pid } = setup();
    const epic = epicWith(db, pid);
    const id = member(db, pid, epic);
    db.prepare("UPDATE agent_tickets SET ready = 0, body = 'no sections' WHERE id = ?").run(id);
    const blocker = member(db, pid, epic);
    db.prepare("INSERT INTO agent_ticket_relations (from_ticket_id, to_ticket_id, type, origin, created_at) VALUES (?, ?, 'blocks', 'human', 0)").run(blocker, id);
    expect((await patch(app, id, { status: 'queue' })).statusCode).toBe(200);
  });

  it('never gates human work — the /harness claim keeps working on an unrefined ticket', async () => {
    const { app, db, pid } = setup();
    const epic = epicWith(db, pid, 0);
    const id = member(db, pid, epic, { refined: 0, assignee: null });
    const res = await patch(app, id, { assignee: 'steve', status: 'queue' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ assignee: 'steve', status: 'queue' });
  });

  it('allows un-refining a ticket already queued — the loop backstop owns that case', async () => {
    const { app, db, pid } = setup();
    const epic = epicWith(db, pid);
    const id = member(db, pid, epic);
    expect((await patch(app, id, { status: 'queue' })).statusCode).toBe(200);
    expect((await patch(app, id, { refined: false })).statusCode).toBe(200);
    expect((await patch(app, id, { title: 'renamed' })).statusCode).toBe(200);
  });
});

describe('PATCH — the Queue gate on an Epic (D-091 × D-080 cascade)', () => {
  it('refuses queueing an Epic that would arm an unrefined robot member, and arms nothing', async () => {
    const { app, db, pid } = setup();
    const epic = epicWith(db, pid);
    const ok = member(db, pid, epic);
    const bad = member(db, pid, epic, { refined: 0 });
    const res = await patch(app, epic, { status: 'queue' });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('QUEUE_GATE');
    expect(getTicket(db, ok)?.status).toBe('backlog');
    expect(getTicket(db, bad)?.status).toBe('backlog');
  });

  it('refuses queueing an unrefined Epic with robot members', async () => {
    const { app, db, pid } = setup();
    const epic = epicWith(db, pid, 0);
    member(db, pid, epic);
    expect((await patch(app, epic, { status: 'queue' })).statusCode).toBe(409);
  });

  it('queues a refined Epic whose open members are all refined', async () => {
    const { app, db, pid } = setup();
    const epic = epicWith(db, pid);
    const m = member(db, pid, epic);
    expect((await patch(app, epic, { status: 'queue' })).statusCode).toBe(200);
    expect(getTicket(db, m)?.status).toBe('queue');
  });

  it('does not gate an Epic with no robot members to arm', async () => {
    const { app, db, pid } = setup();
    const epic = epicWith(db, pid, 0);
    const m = member(db, pid, epic, { refined: 0, assignee: 'steve' });
    expect((await patch(app, epic, { status: 'queue' })).statusCode).toBe(200);
    expect(getTicket(db, m)?.status).toBe('queue');
  });
});

describe('POST /refine-approve { queue: true } — the Queue gate (D-091)', () => {
  function seedProposal(db: Database.Database, ticketId: number, proposal: unknown) {
    db.prepare('INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)').run(
      ticketId,
      'refine_proposal',
      JSON.stringify(proposal),
      Date.now(),
    );
  }

  it('refuses Approve & queue for a robot ticket under an unrefined Epic, and approves nothing', async () => {
    const { app, db, pid } = setup();
    const epic = epicWith(db, pid, 0);
    const id = member(db, pid, epic, { refined: 0 });
    seedProposal(db, id, { mode: 'refine_in_place', body: READY_BODY });
    const res = await app.inject({ method: 'POST', url: `${base}/tickets/${id}/refine-approve`, payload: { queue: true } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('QUEUE_GATE');
    // The ticket's own `refined` is satisfied by the approval itself; only the Epic is unmet.
    const unmet = res.json().blockers.filter((c: { met: boolean }) => !c.met).map((c: { id: string }) => c.id);
    expect(unmet).toEqual(['epic-refined']);
    expect(getTicket(db, id)).toMatchObject({ status: 'backlog', refined: false });
  });

  it('admits Approve & queue when the Epic is refined — approving satisfies the ticket’s own criterion', async () => {
    const { app, db, pid } = setup();
    const epic = epicWith(db, pid);
    const id = member(db, pid, epic, { refined: 0 });
    seedProposal(db, id, { mode: 'refine_in_place', body: READY_BODY });
    const res = await app.inject({ method: 'POST', url: `${base}/tickets/${id}/refine-approve`, payload: { queue: true } });
    expect(res.statusCode).toBe(201);
    expect(getTicket(db, id)).toMatchObject({ status: 'queue', refined: true });
  });
});

describe('✓ Mark refined on a stale queued Epic — resume holds back robot work that cannot pass (D-091)', () => {
  it('arms human members, holds unrefined-member robot work in backlog, and records the hold', async () => {
    const { app, db, pid } = setup();
    const epic = epicWith(db, pid);
    const robot = member(db, pid, epic);
    const unrefinedRobot = member(db, pid, epic, { refined: 0 });
    const human = member(db, pid, epic, { assignee: 'steve' });
    setFlags(db, epic, { status: 'queue', stale: 1, refined: 0 });
    const res = await app.inject({ method: 'POST', url: `${base}/tickets/${epic}/mark-refined` });
    expect(res.statusCode).toBe(200);
    expect(getTicket(db, human)?.status).toBe('queue');
    expect(getTicket(db, robot)?.status).toBe('backlog');
    expect(getTicket(db, unrefinedRobot)?.status).toBe('backlog');
    expect(listTicketEvents(db, epic).some((e) => e.type === 'epic_resume_held')).toBe(true);
  });

  it('arms robot members too once every open member is refined', async () => {
    const { app, db, pid } = setup();
    const epic = epicWith(db, pid);
    const robot = member(db, pid, epic);
    setFlags(db, epic, { status: 'queue', stale: 1, refined: 0 });
    expect((await app.inject({ method: 'POST', url: `${base}/tickets/${epic}/mark-refined` })).statusCode).toBe(200);
    expect(getTicket(db, robot)?.status).toBe('queue');
  });
});
