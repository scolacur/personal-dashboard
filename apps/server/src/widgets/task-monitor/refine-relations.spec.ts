import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { bootstrapSchema } from './schema';
import { approveRefine, createTicket, getProjectBySlug, getTicket, listAllRelations, listEpicMembers } from './store';

// PD-842: a decompose proposal can carry relations between its children (by index), written on
// approval in the same transaction as the children themselves.

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

/** Sibling edges among the given ticket ids, as `fromTitle type toTitle` strings. */
function edges(db: Database.Database, ids: number[]): string[] {
  const title = (id: number) => getTicket(db, id)?.title;
  return listAllRelations(db)
    .filter((r) => r.type !== 'split' && ids.includes(r.fromTicketId) && ids.includes(r.toTicketId))
    .map((r) => `${title(r.fromTicketId)} ${r.type} ${title(r.toTicketId)} (${r.origin})`)
    .sort();
}

describe('approveRefine — proposed relations (PD-842)', () => {
  it('a split writes the children AND their blocks/relates edges, origin agent', () => {
    const { db, pid } = setup();
    const epic = createTicket(db, { title: 'epic', projectId: pid, isEpic: true });
    const parent = createTicket(db, { title: 'parent', projectId: pid, epicId: epic.id });
    propose(db, parent.id, {
      mode: 'decompose',
      children: [child('a'), child('b'), child('c')],
      relations: [
        { from: 0, to: 1, type: 'blocks' },
        { from: 0, to: 2, type: 'blocks' },
        { from: 1, to: 2, type: 'relates' },
      ],
    });
    expect(approveRefine(db, parent.id, {}).ok).toBe(true);
    const ids = listEpicMembers(db, epic.id).map((m) => m.id);
    expect(edges(db, ids)).toEqual(['a blocks b (agent)', 'a blocks c (agent)', 'b relates c (agent)']);
    expect(getTicket(db, parent.id)?.status).toBe('closed');
  });

  it('a Populate writes the edges between the new members too', () => {
    const { db, pid } = setup();
    const epic = createTicket(db, { title: 'epic', projectId: pid, isEpic: true });
    propose(db, epic.id, {
      mode: 'decompose',
      body: 'Epic framed for its members.',
      children: [child('x'), child('y')],
      relations: [{ from: 0, to: 1, type: 'blocks' }],
    });
    expect(approveRefine(db, epic.id, {})).toMatchObject({ ok: true, populated: true });
    const ids = listEpicMembers(db, epic.id).map((m) => m.id);
    expect(edges(db, ids)).toEqual(['x blocks y (agent)']);
  });

  it('a proposal without relations approves exactly as before — no sibling edges', () => {
    const { db, pid } = setup();
    const epic = createTicket(db, { title: 'epic', projectId: pid, isEpic: true });
    const parent = createTicket(db, { title: 'parent', projectId: pid, epicId: epic.id });
    propose(db, parent.id, { mode: 'decompose', children: [child('a'), child('b')] });
    expect(approveRefine(db, parent.id, {}).ok).toBe(true);
    expect(edges(db, listEpicMembers(db, epic.id).map((m) => m.id))).toEqual([]);
  });

  it.each([
    ['an out-of-range index', [{ from: 0, to: 5, type: 'blocks' }], /only 2 children/],
    ['a self-edge', [{ from: 1, to: 1, type: 'relates' }], /itself/],
    ['a blocks cycle', [{ from: 0, to: 1, type: 'blocks' }, { from: 1, to: 0, type: 'blocks' }], /cycle/],
  ])('a stored proposal with %s is refused whole — no children, parent untouched', (_l, relations, msg) => {
    const { db, pid } = setup();
    const epic = createTicket(db, { title: 'epic', projectId: pid, isEpic: true });
    const parent = createTicket(db, { title: 'parent', projectId: pid, epicId: epic.id });
    propose(db, parent.id, { mode: 'decompose', children: [child('a'), child('b')], relations });
    const res = approveRefine(db, parent.id, {});
    expect(res).toMatchObject({ ok: false, reason: 'invalid_proposal' });
    expect(res.ok === false && res.detail).toMatch(msg);
    expect(listEpicMembers(db, epic.id).map((m) => m.title)).toEqual(['parent']);
    expect(getTicket(db, parent.id)?.status).toBe('backlog');
  });
});
