import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { bootstrapSchema } from './schema';
import { approveRefine, createTicket, getProjectBySlug, getTicket, listEpicMembers } from './store';

// PD-634: a Refine session's output is born refined — its children, and the Epic it populates.

const READY_BODY = '## Context\nc\n## Task\nt\n## Done When\nd\n## Out of scope\no';
const EPIC_BODY = 'The Epic, reframed for the members below.';

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

function child(title: string, o: { body?: string; assignee?: 'robot' | 'steve' | null; refined?: boolean } = {}) {
  return {
    title,
    body: o.body ?? READY_BODY,
    status: 'backlog',
    assignee: o.assignee === undefined ? 'robot' : o.assignee,
    ...(o.refined !== undefined ? { refined: o.refined } : {}),
  };
}

function refinedByTitle(db: Database.Database, epicId: number): Record<string, boolean> {
  return Object.fromEntries(listEpicMembers(db, epicId).map((m) => [m.title, m.refined]));
}

describe('approveRefine Populate — born refined (PD-634)', () => {
  it('leaves N refined members and a refined Epic with its rewritten body — N ≥ 2, so the mark survives every join', () => {
    const { db, pid } = setup();
    const epic = createTicket(db, { title: 'epic', body: 'old description', projectId: pid, isEpic: true });
    propose(db, epic.id, { mode: 'decompose', body: EPIC_BODY, children: [child('a'), child('b'), child('c')] });
    const res = approveRefine(db, epic.id, {});
    expect(res).toMatchObject({ ok: true, populated: true });
    expect(refinedByTitle(db, epic.id)).toEqual({ a: true, b: true, c: true });
    expect(getTicket(db, epic.id)).toMatchObject({ refined: true, refineStale: false, body: EPIC_BODY });
  });

  it('re-refines an Epic that was ALREADY refined — each join invalidates it, and the last write restores it', () => {
    // The ordering trap (D-089): `createTicket` un-refines a refined Epic on every member that joins.
    // Marking first would be undone by the next child.
    const { db, pid } = setup();
    const epic = createTicket(db, { title: 'epic', projectId: pid, isEpic: true });
    db.prepare('UPDATE agent_tickets SET refined = 1 WHERE id = ?').run(epic.id);
    propose(db, epic.id, { mode: 'decompose', body: EPIC_BODY, children: [child('a'), child('b')] });
    expect(approveRefine(db, epic.id, {}).ok).toBe(true);
    expect(getTicket(db, epic.id)).toMatchObject({ refined: true, refineStale: false });
  });

  it('a child the agent marks `refined: false` lands unrefined', () => {
    const { db, pid } = setup();
    const epic = createTicket(db, { title: 'epic', projectId: pid, isEpic: true });
    propose(db, epic.id, { mode: 'decompose', body: EPIC_BODY, children: [child('a'), child('placeholder', { refined: false })] });
    approveRefine(db, epic.id, {});
    expect(refinedByTitle(db, epic.id)).toEqual({ a: true, placeholder: false });
  });

  it('downgrades a robot child whose body is not Ready-shaped, whatever the proposal claimed', () => {
    const { db, pid } = setup();
    const epic = createTicket(db, { title: 'epic', projectId: pid, isEpic: true });
    propose(db, epic.id, {
      mode: 'decompose',
      body: EPIC_BODY,
      children: [child('shaped'), child('unshaped', { body: 'just a sentence', refined: true })],
    });
    approveRefine(db, epic.id, {});
    expect(refinedByTitle(db, epic.id)).toEqual({ shaped: true, unshaped: false });
  });

  it('a human child with a non-Robot-shaped body still lands refined — refined is not ready (D-058)', () => {
    const { db, pid } = setup();
    const epic = createTicket(db, { title: 'epic', projectId: pid, isEpic: true });
    propose(db, epic.id, {
      mode: 'decompose',
      body: EPIC_BODY,
      children: [child('for steve', { body: 'just a sentence', assignee: 'steve' }), child('unassigned', { body: 'prose', assignee: null })],
    });
    approveRefine(db, epic.id, {});
    expect(refinedByTitle(db, epic.id)).toEqual({ 'for steve': true, unassigned: true });
  });

  it('refuses a Populate with no Epic body, and writes nothing', () => {
    const { db, pid } = setup();
    const epic = createTicket(db, { title: 'epic', body: 'old description', projectId: pid, isEpic: true });
    propose(db, epic.id, { mode: 'decompose', children: [child('a')] });
    const res = approveRefine(db, epic.id, {});
    expect(res).toMatchObject({ ok: false, reason: 'invalid_proposal' });
    expect(listEpicMembers(db, epic.id)).toEqual([]);
    expect(getTicket(db, epic.id)).toMatchObject({ refined: false, body: 'old description' });
  });

  it('a non-Epic split also gives its children born-refined status, and needs no body', () => {
    const { db, pid } = setup();
    const epic = createTicket(db, { title: 'epic', projectId: pid, isEpic: true });
    const parent = createTicket(db, { title: 'parent', projectId: pid, epicId: epic.id });
    propose(db, parent.id, { mode: 'decompose', children: [child('x'), child('y', { refined: false })] });
    const res = approveRefine(db, parent.id, {});
    expect(res.ok).toBe(true);
    expect(refinedByTitle(db, epic.id)).toMatchObject({ x: true, y: false });
    expect(getTicket(db, parent.id)?.status).toBe('closed');
  });
});
