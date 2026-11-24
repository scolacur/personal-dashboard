import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { latestActionableProposal, REFINE_PROPOSAL_EVENT } from '@dashboard/shared';
import { bootstrapSchema } from './schema';
import {
  approveRefine,
  createTicket,
  getProjectBySlug,
  getTicket,
  listEpicMembers,
  listTicketEvents,
  updateTicket,
} from './store';

// PD-931: a decompose/Populate proposal may `supersedes` existing members of the Epic. On approval
// each is re-validated against the live board, then closed + logged `refine_superseded` inside the
// one approval transaction (the PD-837 / PD-847 shape — a member with its own pending proposal that
// a Populate replaces).

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
    REFINE_PROPOSAL_EVENT.proposal,
    JSON.stringify(proposal),
    Date.now(),
  );
}

const child = (title: string) => ({ title, body: READY_BODY, status: 'backlog', assignee: 'robot' });

const supersededEvents = (db: Database.Database, ticketId: number) =>
  listTicketEvents(db, ticketId).filter((e) => e.type === REFINE_PROPOSAL_EVENT.superseded);

describe('approveRefine — supersedes closes members (PD-931)', () => {
  it('closes a superseded member, logs refine_superseded, and retires its own proposal', () => {
    const { db, pid } = setup();
    const epic = createTicket(db, { title: 'epic', projectId: pid, isEpic: true });
    // A member with its OWN pending proposal (the PD-837 / PD-847 shape).
    const member = createTicket(db, { title: 'old member', projectId: pid, epicId: epic.id });
    propose(db, member.id, { mode: 'refine_in_place', body: 'the old member reworked' });
    expect(latestActionableProposal(listTicketEvents(db, member.id))).not.toBeNull();

    // A Populate on the Epic that supersedes that member.
    propose(db, epic.id, {
      mode: 'decompose',
      body: 'Epic reframed around its new members.',
      children: [child('new work')],
      supersedes: [member.displayId],
    });

    const res = approveRefine(db, epic.id, {});
    expect(res).toMatchObject({ ok: true, populated: true });

    // The member is closed, carries a refine_superseded event naming the Epic, and its own proposal
    // is no longer actionable.
    expect(getTicket(db, member.id)?.status).toBe('closed');
    const sup = supersededEvents(db, member.id);
    expect(sup).toHaveLength(1);
    expect((sup[0].detail as { by?: string }).by).toBe(epic.displayId);
    expect(latestActionableProposal(listTicketEvents(db, member.id))).toBeNull();

    // The committed event on the Epic records what it superseded.
    const committed = listTicketEvents(db, epic.id).filter(
      (e) => e.type === REFINE_PROPOSAL_EVENT.committed,
    );
    expect(committed).toHaveLength(1);
    expect((committed[0].detail as { superseded?: string[] }).superseded).toEqual([member.displayId]);

    // Approving the now-closed member refuses and creates nothing.
    const after = approveRefine(db, member.id, {});
    expect(after.ok).toBe(false);
    // The new member is the only addition; the old one is retained (closed), not deleted.
    const titles = listEpicMembers(db, epic.id)
      .map((m) => m.title)
      .sort();
    expect(titles).toEqual(['new work', 'old member']);
  });

  it('is idempotent when the named member is already closed — no second close, no duplicate event', () => {
    const { db, pid } = setup();
    const epic = createTicket(db, { title: 'epic', projectId: pid, isEpic: true });
    const member = createTicket(db, { title: 'already closed', projectId: pid, epicId: epic.id });
    updateTicket(db, member.id, { status: 'closed' });

    propose(db, epic.id, {
      mode: 'decompose',
      body: 'Epic reframed.',
      children: [child('new work')],
      supersedes: [member.displayId],
    });
    expect(approveRefine(db, epic.id, {}).ok).toBe(true);

    expect(getTicket(db, member.id)?.status).toBe('closed');
    // Idempotent: a member already closed is skipped, so no refine_superseded is written.
    expect(supersededEvents(db, member.id)).toHaveLength(0);
  });

  it.each([
    [
      'a ticket that is not a member of the Epic',
      (db: Database.Database, pid: number) =>
        createTicket(db, { title: 'outsider', projectId: pid }).displayId,
      /not a member/,
    ],
    [
      'a completed member',
      (db: Database.Database, pid: number, epicId: number) => {
        const m = createTicket(db, { title: 'done', projectId: pid, epicId });
        updateTicket(db, m.id, { status: 'completed' });
        return m.displayId;
      },
      /already completed/,
    ],
    ['a display id with no ticket', () => 'PD-99999', /no such open ticket/],
  ])('refuses the whole approval with no writes when supersedes names %s', (_label, mkId, msg) => {
    const { db, pid } = setup();
    const epic = createTicket(db, { title: 'epic', projectId: pid, isEpic: true });
    const badId = mkId(db, pid, epic.id);

    propose(db, epic.id, {
      mode: 'decompose',
      body: 'Epic reframed.',
      children: [child('new work')],
      supersedes: [badId],
    });
    const res = approveRefine(db, epic.id, {});
    expect(res).toMatchObject({ ok: false, reason: 'invalid_proposal' });
    expect(res.ok === false && res.detail).toMatch(msg);

    // No writes: no children minted, the Epic is left unrefined and open.
    expect(listEpicMembers(db, epic.id).some((m) => m.title === 'new work')).toBe(false);
    expect(getTicket(db, epic.id)?.refined).toBe(false);
    expect(getTicket(db, epic.id)?.status).not.toBe('closed');
  });
});
