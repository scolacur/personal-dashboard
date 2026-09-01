import { describe, it, expect } from 'vitest';
import type { AgentTicket } from '@dashboard/shared';
import {
  isDraggableEpicLane,
  statusForEpicLane,
  membersOf,
  isInFlight,
  planEpicQueue,
  planEpicRollback,
  rollbackNeedsConfirm,
  splitEpicTitle,
} from './epic-drag';

function makeTicket(overrides: Partial<AgentTicket> = {}): AgentTicket {
  return {
    id: 1,
    displayId: 'PD-1',
    projectId: 1,
    title: 'Example ticket',
    body: null,
    status: 'backlog',
    priority: null,
    assignee: null,
    recurInterval: null,
    source: 'manual',
    sortOrder: 0,
    githubIssueNumber: null,
    githubIssueUrl: null,
    agentState: null,
    maxTurns: null,
    agentTurns: null,
    refineState: null,
    refined: false,
    refineStale: false,
    isEpic: false,
    epicId: null,
    ready: false,
    readyBypassed: false,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const ids = (list: AgentTicket[]) => list.map((t) => t.id).sort((a, b) => a - b);

describe('draggable lanes', () => {
  it('allows the two pending lanes', () => {
    expect(isDraggableEpicLane('backlog')).toBe(true);
    expect(isDraggableEpicLane('in_progress')).toBe(true);
  });

  // Progress stays derived (D-080): an Epic reads completed/closed only when its members
  // actually got there, so asserting it by dropping a card would be a lie about the loop's work.
  it('refuses the terminal lanes, which are observations rather than destinations', () => {
    expect(isDraggableEpicLane('completed')).toBe(false);
    expect(isDraggableEpicLane('closed')).toBe(false);
    expect(statusForEpicLane('completed')).toBeNull();
    expect(statusForEpicLane('closed')).toBeNull();
  });

  it('maps a draggable lane to the Epic status it sets', () => {
    expect(statusForEpicLane('backlog')).toBe('backlog');
    expect(statusForEpicLane('in_progress')).toBe('queue');
  });
});

describe('membersOf', () => {
  it('takes only tickets pointing at this epic', () => {
    const tickets = [
      makeTicket({ id: 1, epicId: 10 }),
      makeTicket({ id: 2, epicId: 11 }),
      makeTicket({ id: 3, epicId: 10 }),
      makeTicket({ id: 4, epicId: null }),
    ];
    expect(ids(membersOf(10, tickets))).toEqual([1, 3]);
  });
});

describe('isInFlight', () => {
  it('counts a live session and an open PR the loop is watching', () => {
    expect(isInFlight(makeTicket({ status: 'queue', agentState: 'working' }))).toBe(true);
    expect(isInFlight(makeTicket({ status: 'queue', agentState: 'in-review' }))).toBe(true);
  });

  // Nothing is running for a parked ticket, so it comes back with the Epic.
  it('does not count a parked ticket', () => {
    for (const s of ['stuck', 'needs-human', 'awaiting-human'] as const) {
      expect(isInFlight(makeTicket({ status: 'queue', agentState: s }))).toBe(false);
    }
    expect(isInFlight(makeTicket({ status: 'queue', agentState: 'queued' }))).toBe(false);
    expect(isInFlight(makeTicket({ status: 'queue', agentState: null }))).toBe(false);
  });

  // A stale agent_state on a ticket that already left the queue is not in flight.
  it('requires the ticket to still be in the queue', () => {
    expect(isInFlight(makeTicket({ status: 'backlog', agentState: 'working' }))).toBe(false);
    expect(isInFlight(makeTicket({ status: 'completed', agentState: 'working' }))).toBe(false);
  });
});

describe('planEpicQueue', () => {
  it('arms only the members that have not started', () => {
    const plan = planEpicQueue([
      makeTicket({ id: 1, status: 'backlog' }),
      makeTicket({ id: 2, status: 'queue' }),
      makeTicket({ id: 3, status: 'completed' }),
      makeTicket({ id: 4, status: 'closed' }),
      makeTicket({ id: 5, status: 'backlog' }),
    ]);
    expect(ids(plan.armed)).toEqual([1, 5]);
  });

  it('splits the armed members into what the loop can and cannot take', () => {
    const plan = planEpicQueue([
      makeTicket({ id: 1, status: 'backlog', assignee: 'robot', ready: true }),
      makeTicket({ id: 2, status: 'backlog', assignee: 'robot', ready: false, readyBypassed: true }),
      makeTicket({ id: 3, status: 'backlog', assignee: 'robot', ready: false }),
      makeTicket({ id: 4, status: 'backlog', assignee: 'steve', ready: false }),
      makeTicket({ id: 5, status: 'backlog', assignee: null, ready: true }),
      // Already queued — this drag does not arm it, so it is in none of the buckets.
      makeTicket({ id: 6, status: 'queue', assignee: 'robot', ready: false }),
    ]);
    expect(ids(plan.dispatchable)).toEqual([1, 2]);
    expect(ids(plan.notReady)).toEqual([3]);
    expect(ids(plan.human)).toEqual([4, 5]);
  });

  // The toast reports these counts, so they must add up to what was actually queued.
  it('buckets partition the armed set exactly', () => {
    const members = [
      makeTicket({ id: 1, status: 'backlog', assignee: 'robot', ready: true }),
      makeTicket({ id: 2, status: 'backlog', assignee: 'robot', ready: false }),
      makeTicket({ id: 3, status: 'backlog', assignee: 'steve' }),
      makeTicket({ id: 4, status: 'completed' }),
    ];
    const p = planEpicQueue(members);
    expect(p.dispatchable.length + p.notReady.length + p.human.length).toBe(p.armed.length);
  });
});

describe('planEpicRollback', () => {
  it('pulls back everything queued that is neither terminal nor in flight', () => {
    const plan = planEpicRollback([
      makeTicket({ id: 1, status: 'queue', agentState: null }),
      makeTicket({ id: 2, status: 'queue', agentState: 'queued' }),
      makeTicket({ id: 3, status: 'queue', agentState: 'stuck' }),
      makeTicket({ id: 4, status: 'queue', agentState: 'needs-human' }),
      makeTicket({ id: 5, status: 'queue', agentState: 'awaiting-human' }),
      makeTicket({ id: 6, status: 'backlog' }),
      makeTicket({ id: 7, status: 'completed' }),
      makeTicket({ id: 8, status: 'closed' }),
    ]);
    expect(ids(plan.pullBack)).toEqual([1, 2, 3, 4, 5]);
    expect(plan.inFlight).toHaveLength(0);
    expect(plan.movesEpic).toBe(true);
  });

  // The bug this design fixes: the Epic's lane is derived, and any member left in `queue` makes it
  // read `in_progress`. Moving the Epic anyway wrote a status the view instantly overruled.
  it('leaves the Epic in the Queue when work is in flight', () => {
    const plan = planEpicRollback([
      makeTicket({ id: 1, status: 'queue', agentState: 'working' }),
      makeTicket({ id: 2, status: 'queue', agentState: 'queued' }),
      makeTicket({ id: 3, status: 'queue', agentState: 'stuck' }),
    ]);
    expect(ids(plan.inFlight)).toEqual([1]);
    expect(ids(plan.pullBack)).toEqual([2, 3]);
    expect(plan.movesEpic).toBe(false);
  });

  it('treats an in-review PR as in flight so it is never stranded', () => {
    const plan = planEpicRollback([makeTicket({ id: 1, status: 'queue', agentState: 'in-review' })]);
    expect(ids(plan.inFlight)).toEqual([1]);
    expect(plan.pullBack).toHaveLength(0);
    expect(plan.movesEpic).toBe(false);
  });

  it('leaves terminal members alone — a half-done Epic is the normal in-flight state', () => {
    const plan = planEpicRollback([
      makeTicket({ id: 1, status: 'completed', agentState: 'done' }),
      makeTicket({ id: 2, status: 'closed' }),
    ]);
    expect(plan.pullBack).toHaveLength(0);
    expect(plan.inFlight).toHaveLength(0);
    expect(plan.movesEpic).toBe(true);
  });
});

describe('rollbackNeedsConfirm', () => {
  it('stays silent when nothing is in flight', () => {
    expect(
      rollbackNeedsConfirm(
        planEpicRollback([
          makeTicket({ id: 1, status: 'queue', agentState: null }),
          makeTicket({ id: 2, status: 'queue', agentState: 'stuck' }),
          makeTicket({ id: 3, status: 'completed' }),
        ]),
      ),
    ).toBe(false);
  });

  it('asks only about work it cannot recall', () => {
    expect(
      rollbackNeedsConfirm(planEpicRollback([makeTicket({ status: 'queue', agentState: 'working' })])),
    ).toBe(true);
    expect(
      rollbackNeedsConfirm(planEpicRollback([makeTicket({ status: 'queue', agentState: 'in-review' })])),
    ).toBe(true);
  });

  it('stays silent for an Epic with no members at all', () => {
    expect(rollbackNeedsConfirm(planEpicRollback([]))).toBe(false);
  });
});

describe('splitEpicTitle', () => {
  it('keeps an existing [Epic] prefix', () => {
    expect(splitEpicTitle('[Epic] Music Tracker Widget')).toBe('[Epic] Music Tracker Widget — active work');
  });

  it('does not invent a prefix where the board has none', () => {
    expect(splitEpicTitle('Misc Minor Bugfixes')).toBe('Misc Minor Bugfixes — active work');
  });

  it('tolerates odd spacing', () => {
    expect(splitEpicTitle('[Epic]   Spaced  ')).toBe('[Epic]   Spaced — active work');
  });
});
