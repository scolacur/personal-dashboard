import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { bootstrapSchema } from './schema';
import { registerRoutes } from './routes';
import { createTicket, decideCheckpoint, getNeedsHumanTickets, getProjectBySlug, getTicket, listTicketEvents } from './store';

/**
 * D-094/PD-737 — answering a checkpoint. The loop parks a ticket that hit its turn ceiling in
 * `checkpoint`; Continue / Restart record Steve's choice as an event and re-queue it. The loop reads
 * the event at its next dispatch (agent-worker `checkpoint.ts`).
 */
function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrapSchema(db);
  return db;
}

function seed(db: Database.Database, agentState: string | null, status = 'queue'): number {
  const p = getProjectBySlug(db, 'personal-dashboard');
  if (!p) throw new Error('no PD project');
  const t = createTicket(db, { title: 'hit the ceiling', projectId: p.id });
  db.prepare("UPDATE agent_tickets SET status = ?, assignee = 'robot', agent_state = ? WHERE id = ?").run(status, agentState, t.id);
  return t.id;
}

describe('decideCheckpoint', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('Continue logs robot_checkpoint_continue with the turns and re-queues', () => {
    const id = seed(db, 'checkpoint');
    const r = decideCheckpoint(db, id, { kind: 'continue', extraTurns: 80 });
    expect(r.ok && r.ticket.agentState).toBe('queued');
    const e = listTicketEvents(db, id).find((x) => x.type === 'robot_checkpoint_continue');
    expect(e?.detail).toMatchObject({ extraTurns: 80 });
  });

  it('Restart logs robot_checkpoint_restart and re-queues', () => {
    const id = seed(db, 'checkpoint');
    expect(decideCheckpoint(db, id, { kind: 'restart' }).ok).toBe(true);
    expect(getTicket(db, id)?.agentState).toBe('queued');
    expect(listTicketEvents(db, id).map((e) => e.type)).toContain('robot_checkpoint_restart');
  });

  it('writes no retry-boundary event — a checkpoint never consumed retry budget', () => {
    const id = seed(db, 'checkpoint');
    decideCheckpoint(db, id, { kind: 'continue', extraTurns: 50 });
    const types = listTicketEvents(db, id).map((e) => e.type);
    expect(types).not.toContain('robot_reset');
    expect(types).not.toContain('robot_unstick');
  });

  it.each(['stuck', 'queued', 'working', 'in-review', null])('refuses a ticket in %s (only `checkpoint` may be answered)', (state) => {
    const id = seed(db, state);
    expect(decideCheckpoint(db, id, { kind: 'restart' })).toEqual({ ok: false, reason: 'not_checkpoint' });
    expect(listTicketEvents(db, id).map((e) => e.type)).not.toContain('robot_checkpoint_restart');
  });

  it('refuses a checkpoint ticket that has left the Queue', () => {
    const id = seed(db, 'checkpoint', 'backlog');
    expect(decideCheckpoint(db, id, { kind: 'continue', extraTurns: 50 })).toEqual({ ok: false, reason: 'not_checkpoint' });
  });

  it('a checkpoint counts as "needs you"', () => {
    const id = seed(db, 'checkpoint');
    expect(getNeedsHumanTickets(db).map((t) => t.id)).toContain(id);
  });
});

describe('POST /tickets/:id/robot/continue | restart', () => {
  function setup() {
    const db = freshDb();
    const app = Fastify({ logger: false });
    registerRoutes(app, db);
    return { app, db };
  }
  const url = (id: number, action: string) => `/api/widgets/task-monitor/tickets/${id}/robot/${action}`;

  it('Continue defaults to +50 turns', async () => {
    const { app, db } = setup();
    const id = seed(db, 'checkpoint');
    const res = await app.inject({ method: 'POST', url: url(id, 'continue') });
    expect(res.statusCode).toBe(200);
    expect(res.json().agentState).toBe('queued');
    expect(listTicketEvents(db, id).find((e) => e.type === 'robot_checkpoint_continue')?.detail).toMatchObject({ extraTurns: 50 });
  });

  it('accepts 200 and rejects 201 — rejected, not clamped (D-066)', async () => {
    const { app, db } = setup();
    const id = seed(db, 'checkpoint');
    const over = await app.inject({ method: 'POST', url: url(id, 'continue'), payload: { extraTurns: 201 } });
    expect(over.statusCode).toBe(400);
    expect(over.json().code).toBe('INVALID_EXTRA_TURNS');
    expect(getTicket(db, id)?.agentState).toBe('checkpoint'); // untouched
    const ok = await app.inject({ method: 'POST', url: url(id, 'continue'), payload: { extraTurns: 200 } });
    expect(ok.statusCode).toBe(200);
  });

  it.each([0, -5, 2.5, '50'])('rejects extraTurns=%s', async (extraTurns) => {
    const { app, db } = setup();
    const id = seed(db, 'checkpoint');
    const res = await app.inject({ method: 'POST', url: url(id, 'continue'), payload: { extraTurns } });
    expect(res.statusCode).toBe(400);
  });

  it('409 for a ticket not at a checkpoint, 404 for a missing one', async () => {
    const { app, db } = setup();
    const id = seed(db, 'stuck');
    expect((await app.inject({ method: 'POST', url: url(id, 'restart') })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: url(id, 'continue') })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: url(99999, 'restart') })).statusCode).toBe(404);
  });

  it('Restart re-queues', async () => {
    const { app, db } = setup();
    const id = seed(db, 'checkpoint');
    const res = await app.inject({ method: 'POST', url: url(id, 'restart') });
    expect(res.statusCode).toBe(200);
    expect(getTicket(db, id)?.agentState).toBe('queued');
  });
});
