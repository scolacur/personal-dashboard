import { describe, it, expect } from 'vitest';
import type { AgentTicket, TicketRelation } from '@dashboard/shared';
import {
  entersRobotQueue,
  epicAggregate,
  gateFromServer,
  gateOutcome,
  openBlockerIds,
  planEpicGate,
  planTicketGate,
  ticketHref,
} from './queue-gate';

function t(overrides: Partial<AgentTicket> = {}): AgentTicket {
  return {
    id: 1,
    displayId: 'PD-1',
    projectId: 1,
    title: 'A ticket',
    body: null,
    status: 'backlog',
    priority: null,
    assignee: 'robot',
    recurInterval: null,
    source: 'manual',
    sortOrder: 0,
    githubIssueNumber: null,
    githubIssueUrl: null,
    agentState: null,
    maxTurns: null,
    agentTurns: null,
    refineState: null,
    refined: true,
    refineStale: false,
    isEpic: false,
    epicId: 10,
    ready: true,
    readyBypassed: false,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const epic = (over: Partial<AgentTicket> = {}) =>
  t({ id: 10, displayId: 'PD-10', title: '[Epic] E', isEpic: true, epicId: null, assignee: null, ...over });

const blocks = (from: number, to: number): TicketRelation => ({
  id: from * 100 + to,
  fromTicketId: from,
  toTicketId: to,
  type: 'blocks',
  origin: 'human',
  createdAt: 0,
});

const READY_BODY = '## Context\nx\n## Task\nx\n## Done When\nx\n## Out of scope\nx';

describe('entersRobotQueue', () => {
  const backlog = { status: 'backlog' as const, assignee: 'robot' as const, epicId: 10 };

  it('is entering the Queue as the Robot', () => {
    expect(entersRobotQueue(backlog, { status: 'queue' })).toBe(true);
  });

  it('is setting the Robot on a ticket already queued', () => {
    expect(entersRobotQueue({ ...backlog, status: 'queue', assignee: 'steve' }, { assignee: 'robot' })).toBe(true);
  });

  it('is re-parenting a queued Robot ticket', () => {
    expect(entersRobotQueue({ ...backlog, status: 'queue' }, { epicId: 11 })).toBe(true);
  });

  it('is creating straight into the Queue for the Robot', () => {
    expect(entersRobotQueue(null, { status: 'queue', assignee: 'robot' })).toBe(true);
  });

  it('is not a reorder inside the Queue', () => {
    expect(entersRobotQueue({ ...backlog, status: 'queue' }, { status: 'queue' })).toBe(false);
  });

  it('never gates a human ticket (PD-632)', () => {
    expect(entersRobotQueue({ ...backlog, assignee: 'steve' }, { status: 'queue' })).toBe(false);
    expect(entersRobotQueue(null, { status: 'queue', assignee: 'steve' })).toBe(false);
  });

  it('does not gate a move out of the Queue', () => {
    expect(entersRobotQueue({ ...backlog, status: 'queue' }, { status: 'backlog' })).toBe(false);
  });
});

describe('planTicketGate', () => {
  const judge = (ticket: AgentTicket, tickets: AgentTicket[], relations: TicketRelation[] = []) =>
    planTicketGate({ existing: ticket, write: { status: 'queue' }, tickets, relations });

  it('proceeds when every criterion is met', () => {
    const ticket = t();
    const gate = judge(ticket, [epic(), ticket])!;
    expect(gate.refused).toEqual([]);
    expect(gateOutcome(gate)).toBe('proceed');
    expect(gate.criteria.every((c) => c.met)).toBe(true);
  });

  it('refuses on one hard unmet criterion, and Confirm is not offered', () => {
    const ticket = t({ refined: false });
    const gate = judge(ticket, [epic(), ticket])!;
    expect(gate.refused.map((c) => c.id)).toEqual(['refined']);
    expect(gateOutcome(gate)).toBe('refuse');
  });

  it('asks for the D-058 bypass when only `ready` is unmet', () => {
    const ticket = t({ ready: false });
    const gate = judge(ticket, [epic(), ticket])!;
    expect(gate.refused).toEqual([]);
    expect(gateOutcome(gate)).toBe('bypass');
  });

  it('does not re-ask a ticket whose bypass is already recorded', () => {
    const ticket = t({ ready: false, readyBypassed: true });
    expect(gateOutcome(judge(ticket, [epic(), ticket])!)).toBe('proceed');
  });

  it('refuses rather than bypasses when `ready` and a hard criterion both fail', () => {
    // The override would not help, so it must not be what is offered.
    const ticket = t({ ready: false, refined: false });
    expect(gateOutcome(judge(ticket, [epic(), ticket])!)).toBe('refuse');
  });

  it('refuses a member of a stale Epic — what PD-611 refused, now one row of the checklist', () => {
    const ticket = t();
    const gate = judge(ticket, [epic({ refined: false, refineStale: true }), ticket])!;
    expect(gate.refused.map((c) => c.id)).toEqual(['epic-refined', 'epic-not-stale']);
    expect(gate.epic?.displayId).toBe('PD-10');
  });

  it('names the open, unrefined members behind `members-refined`, not finished ones', () => {
    const ticket = t();
    const open = t({ id: 2, displayId: 'PD-2', refined: false });
    const done = t({ id: 3, displayId: 'PD-3', refined: false, status: 'completed' });
    const gate = judge(ticket, [epic(), ticket, open, done])!;
    expect(gate.refused.map((c) => c.id)).toEqual(['members-refined']);
    expect(gate.unrefinedMembers.map((m) => m.displayId)).toEqual(['PD-2']);
  });

  it('lists open blockers but lets the ticket wait in the Queue (D-051 as amended by PD-408)', () => {
    const ticket = t();
    const blocker = t({ id: 5, displayId: 'PD-5', assignee: 'steve' });
    const gate = judge(ticket, [epic(), ticket, blocker], [blocks(5, 1)])!;
    expect(gate.criteria.find((c) => c.id === 'unblocked')?.met).toBe(false);
    expect(gate.blockers.map((b) => b.displayId)).toEqual(['PD-5']);
    expect(gateOutcome(gate)).toBe('proceed');
  });

  it('judges the body as written, not as stored', () => {
    const ticket = t({ ready: false });
    const gate = planTicketGate({
      existing: ticket,
      write: { status: 'queue', body: READY_BODY },
      tickets: [epic(), ticket],
      relations: [],
    })!;
    expect(gateOutcome(gate)).toBe('proceed');
  });

  it('always refuses a create into the Robot Queue: a new ticket is born unrefined', () => {
    const gate = planTicketGate({
      existing: null,
      write: { status: 'queue', assignee: 'robot', epicId: 10, body: READY_BODY },
      draftTitle: 'Brand new',
      tickets: [epic()],
      relations: [],
    })!;
    expect(gate.ticket).toBeNull();
    expect(gate.label).toBe('Brand new');
    expect(gate.refused.map((c) => c.id)).toEqual(['refined']);
  });

  it('returns null when the write does not enter the gated state', () => {
    const ticket = t();
    expect(planTicketGate({ existing: ticket, write: { status: 'backlog' }, tickets: [ticket], relations: [] })).toBeNull();
  });
});

describe('planEpicGate', () => {
  it('reports the per-Epic aggregate and the members that hold it up', () => {
    const e = epic();
    const members = [
      t({ id: 1, displayId: 'PD-1' }),
      t({ id: 2, displayId: 'PD-2', refined: false }),
      t({ id: 3, displayId: 'PD-3', ready: false }),
      t({ id: 4, displayId: 'PD-4', assignee: 'steve', refined: false }),
      t({ id: 5, displayId: 'PD-5', status: 'completed', refined: false }),
    ];
    const gate = planEpicGate(e, [e, ...members], [])!;
    expect(gate.armed).toBe(3);
    expect(gate.clear).toBe(1);
    expect(epicAggregate(gate)).toBe('1 of 3 Robot members are clear to run');
    expect(gate.refused.map((c) => c.id)).toEqual(['members-refined']);
    expect(gateOutcome(gate)).toBe('refuse');
    // The human member is unrefined, so it holds the Epic up too; the finished one does not.
    expect(gate.members.map((m) => [m.member.displayId, m.unmet.map((c) => c.id)])).toEqual([
      ['PD-2', ['refined']],
      ['PD-3', ['ready']],
      ['PD-4', ['refined']],
    ]);
  });

  it('refuses a stale Epic in bulk — the other half of what PD-611 refused', () => {
    const e = epic({ refined: false, refineStale: true });
    const gate = planEpicGate(e, [e, t()], [])!;
    expect(gate.refused.map((c) => c.id)).toEqual(['epic-refined', 'epic-not-stale']);
  });

  it('lets a refined Epic queue with an unformatted member: the cascade does not refuse on `ready`', () => {
    const e = epic();
    const gate = planEpicGate(e, [e, t({ ready: false })], [])!;
    expect(gateOutcome(gate)).toBe('proceed');
    expect(epicAggregate(gate)).toBe('0 of 1 Robot member is clear to run');
  });

  it('is not gated when the cascade would arm no Robot member', () => {
    const e = epic({ refined: false });
    expect(planEpicGate(e, [e, t({ assignee: 'steve' })], [])).toBeNull();
    expect(planEpicGate(e, [e, t({ status: 'queue' })], [])).toBeNull();
  });
});

describe('gateFromServer', () => {
  it('renders the server criteria when the board predicted wrong', () => {
    const ticket = t();
    const server = planTicketGate({
      existing: t({ refined: false }),
      write: { status: 'queue' },
      tickets: [epic()],
      relations: [],
    })!.criteria;
    const gate = gateFromServer(server, ticket, [epic(), ticket], []);
    expect(gate.kind).toBe('ticket');
    expect(gateOutcome(gate)).toBe('refuse');
  });

  it('builds an Epic gate for an Epic subject', () => {
    const e = epic({ status: 'queue' });
    const gate = gateFromServer([], e, [e, t()], []);
    expect(gate.kind).toBe('epic');
    expect(gate.kind === 'epic' && gate.armed).toBe(1);
  });
});

describe('helpers', () => {
  it('counts only unresolved blockers', () => {
    const tickets = [t({ id: 1 }), t({ id: 5 }), t({ id: 6, status: 'completed' })];
    expect(openBlockerIds(1, [blocks(5, 1), blocks(6, 1), blocks(1, 5)], tickets)).toEqual([5]);
  });

  it('links by display id, or not at all', () => {
    expect(ticketHref({ id: 1, displayId: 'PD-1', title: 'x' })).toBe('/devops/tickets/PD-1');
    expect(ticketHref({ id: 1, displayId: null, title: 'x' })).toBeNull();
    expect(ticketHref(null)).toBeNull();
  });
});
