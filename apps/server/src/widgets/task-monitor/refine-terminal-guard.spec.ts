import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { bootstrapSchema } from './schema';
import { approveRefine, createTicket, getProjectBySlug, getTicket, listEpicMembers } from './store';

// PD-929: a proposal stored before a ticket reached a terminal lane (completed/closed, D-036) must
// not still approve and mint children or rewrite the ticket (root cause #3 of PD-876). The guard is
// also the backstop for structured-supersede: a superseded-and-closed member's own stale proposal
// must be refused.

const READY_BODY = '## Context\nc\n## Task\nt\n## Done When\nd\n## Out of scope\no';

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  bootstrapSchema(db);
  const p = getProjectBySlug(db, 'personal-dashboard');
  if (!p) throw new Error('no project');
  return { db, pid: p.id };
}

function propose(db: Database.Database, ticketId: number, proposal: unknown) {
  db.prepare('INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)').run(
    ticketId,
    'refine_proposal',
    JSON.stringify(proposal),
    Date.now(),
  );
}

const child = (title: string) => ({ title, body: READY_BODY, status: 'backlog', assignee: 'robot' });

describe('approveRefine — terminal guard (PD-929)', () => {
  it.each(['completed', 'closed'] as const)(
    'refuses a refine_in_place proposal on a %s ticket and writes nothing',
    (status) => {
      const { db, pid } = setup();
      const ticket = createTicket(db, { title: 't', body: 'old body', projectId: pid, status });
      propose(db, ticket.id, { mode: 'refine_in_place', body: READY_BODY });

      const res = approveRefine(db, ticket.id, {});
      expect(res).toMatchObject({ ok: false, reason: 'terminal' });
      // No write: the body is untouched and the ticket stays in its terminal lane.
      expect(getTicket(db, ticket.id)?.body).toBe('old body');
      expect(getTicket(db, ticket.id)?.status).toBe(status);
    },
  );

  it.each(['completed', 'closed'] as const)(
    'refuses a decompose proposal on a %s ticket and creates no children',
    (status) => {
      const { db, pid } = setup();
      const epic = createTicket(db, { title: 'epic', projectId: pid, isEpic: true });
      const parent = createTicket(db, { title: 'parent', projectId: pid, epicId: epic.id, status });
      propose(db, parent.id, { mode: 'decompose', children: [child('a'), child('b')] });

      const res = approveRefine(db, parent.id, {});
      expect(res).toMatchObject({ ok: false, reason: 'terminal' });
      // Only the parent is under the Epic — no children were minted.
      expect(listEpicMembers(db, epic.id).map((m) => m.title)).toEqual(['parent']);
      expect(getTicket(db, parent.id)?.status).toBe(status);
    },
  );

  it('refuses a Populate proposal on a closed Epic and leaves it empty', () => {
    const { db, pid } = setup();
    const epic = createTicket(db, { title: 'epic', projectId: pid, isEpic: true, status: 'closed' });
    propose(db, epic.id, {
      mode: 'decompose',
      body: 'Epic framed for its members.',
      children: [child('x'), child('y')],
    });

    const res = approveRefine(db, epic.id, {});
    expect(res).toMatchObject({ ok: false, reason: 'terminal' });
    expect(listEpicMembers(db, epic.id)).toEqual([]);
  });

  it('still approves a proposal on a non-terminal ticket', () => {
    const { db, pid } = setup();
    const ticket = createTicket(db, { title: 't', body: 'old body', projectId: pid, status: 'backlog' });
    propose(db, ticket.id, { mode: 'refine_in_place', body: READY_BODY });

    expect(approveRefine(db, ticket.id, {}).ok).toBe(true);
    expect(getTicket(db, ticket.id)?.body).toBe(READY_BODY);
  });
});
