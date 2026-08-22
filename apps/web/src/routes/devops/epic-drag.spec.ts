import { describe, it, expect } from 'vitest';
import type { AgentTicket } from '@dashboard/shared';
import {
  isDraggableEpicLane,
  statusForEpicLane,
  membersOf,
  planEpicQueue,
  planEpicRollback,
  rollbackNeedsConfirm,
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

  // Progress stays derived (D-TMP-PD383a): an Epic reads completed/closed only when its members
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

describe('planEpicQueue', () => {
  it('arms only the members that have not started', () => {
    const plan = planEpicQueue([
      makeTicket({ id: 1, status: 'backlog' }),
      makeTicket({ id: 2, status: 'queue' }),
      makeTicket({ id: 3, status: 'completed' }),
      makeTicket({ id: 4, status: 'closed' }),
      makeTicket({ id: 5, status: 'backlog' }),
    ]);
    expect(ids(plan.willQueue)).toEqual([1, 5]);
  });

  // The loop gates on `(ready = 1 OR ready_bypassed = 1)` but the Epic cascade does not, so these
  // would sit in the Queue looking perfectly normal and never dispatch (the PD-467 failure mode).
  it('names robot members that will queue but can never be picked up', () => {
    const plan = planEpicQueue([
      makeTicket({ id: 1, status: 'backlog', assignee: 'robot', ready: false }),
      makeTicket({ id: 2, status: 'backlog', assignee: 'robot', ready: true }),
      makeTicket({ id: 3, status: 'backlog', assignee: 'robot', ready: false, readyBypassed: true }),
      // Not the Robot's problem — a human-assigned ticket is never Ready-gated.
      makeTicket({ id: 4, status: 'backlog', assignee: 'steve', ready: false }),
      // Already queued, so this drag does not arm it.
      makeTicket({ id: 5, status: 'queue', assignee: 'robot', ready: false }),
    ]);
    expect(ids(plan.notReady)).toEqual([1]);
  });
});

describe('planEpicRollback', () => {
  it('un-queues members that never started, mirroring the server predicate', () => {
    const plan = planEpicRollback([
      makeTicket({ id: 1, status: 'queue', agentState: null }),
      makeTicket({ id: 2, status: 'queue', agentState: 'queued' }),
      makeTicket({ id: 3, status: 'backlog' }),
      makeTicket({ id: 4, status: 'completed', agentState: 'done' }),
    ]);
    expect(ids(plan.unqueued)).toEqual([1, 2]);
    expect(plan.running).toHaveLength(0);
    expect(plan.parked).toHaveLength(0);
  });

  it('separates a live session from a parked one', () => {
    const plan = planEpicRollback([
      makeTicket({ id: 1, status: 'queue', agentState: 'working' }),
      makeTicket({ id: 2, status: 'queue', agentState: 'in-review' }),
      makeTicket({ id: 3, status: 'queue', agentState: 'stuck' }),
      makeTicket({ id: 4, status: 'queue', agentState: 'needs-human' }),
      makeTicket({ id: 5, status: 'queue', agentState: 'awaiting-human' }),
      makeTicket({ id: 6, status: 'queue', agentState: 'queued' }),
    ]);
    expect(ids(plan.running)).toEqual([1]);
    expect(ids(plan.parked)).toEqual([2, 3, 4, 5]);
    expect(ids(plan.unqueued)).toEqual([6]);
  });

  it('leaves terminal members alone — a half-done Epic is the normal in-flight state', () => {
    const plan = planEpicRollback([
      makeTicket({ id: 1, status: 'completed', agentState: 'done' }),
      makeTicket({ id: 2, status: 'closed' }),
    ]);
    expect(plan.unqueued).toHaveLength(0);
    expect(plan.running).toHaveLength(0);
    expect(plan.parked).toHaveLength(0);
  });
});

describe('rollbackNeedsConfirm', () => {
  it('stays silent when the server cascade handles everything', () => {
    const plan = planEpicRollback([
      makeTicket({ id: 1, status: 'queue', agentState: null }),
      makeTicket({ id: 2, status: 'queue', agentState: 'queued' }),
      makeTicket({ id: 3, status: 'completed' }),
    ]);
    expect(rollbackNeedsConfirm(plan)).toBe(false);
  });

  it('asks when a member is running or parked', () => {
    expect(
      rollbackNeedsConfirm(planEpicRollback([makeTicket({ status: 'queue', agentState: 'working' })])),
    ).toBe(true);
    expect(
      rollbackNeedsConfirm(planEpicRollback([makeTicket({ status: 'queue', agentState: 'stuck' })])),
    ).toBe(true);
  });

  it('stays silent for an Epic with no members at all', () => {
    expect(rollbackNeedsConfirm(planEpicRollback([]))).toBe(false);
  });
});
