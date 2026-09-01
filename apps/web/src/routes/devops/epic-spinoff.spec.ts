import { describe, it, expect } from 'vitest';
import type { AgentTicket } from '@dashboard/shared';
import { planSpinOff } from './epic-spinoff';

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

describe('planSpinOff', () => {
  it('prefills the new Epic name from the ticket', () => {
    const plan = planSpinOff(makeTicket({ title: 'Add a dark mode toggle' }), undefined);
    expect(plan.title).toBe('Add a dark mode toggle');
  });

  it('inherits the source Epic priority, not the ticket copy of it', () => {
    const epic = makeTicket({ id: 10, isEpic: true, priority: 'P1', status: 'backlog' });
    const plan = planSpinOff(makeTicket({ epicId: 10, priority: 'P4' }), epic);
    expect(plan.priority).toBe('P1');
    expect(plan.inheritedFrom).toBe('epic');
  });

  // The point of inheriting the lane: spinning a ticket out of a queued Epic must not quietly
  // un-queue live work by dropping the new Epic into Backlog.
  it('keeps the new Epic in the Queue when the source Epic is queued', () => {
    const epic = makeTicket({ id: 10, isEpic: true, priority: 'P2', status: 'queue' });
    expect(planSpinOff(makeTicket({ epicId: 10, status: 'queue' }), epic).status).toBe('queue');
  });

  it('falls back to the ticket when it has no Epic', () => {
    const plan = planSpinOff(makeTicket({ priority: 'P3', status: 'queue', epicId: null }), undefined);
    expect(plan.priority).toBe('P3');
    expect(plan.status).toBe('queue');
    expect(plan.inheritedFrom).toBe('ticket');
  });

  // An Epic reaches a terminal lane only by its members getting there, so asserting one directly
  // would be overruled by the derived lane on the next render.
  it('never puts the new Epic straight into a terminal lane', () => {
    for (const status of ['completed', 'closed'] as const) {
      const epic = makeTicket({ id: 10, isEpic: true, status });
      expect(planSpinOff(makeTicket({ epicId: 10, status }), epic).status).toBe('backlog');
      expect(planSpinOff(makeTicket({ status }), undefined).status).toBe('backlog');
    }
  });

  it('carries an unpriced Epic through as unpriced rather than inventing a priority', () => {
    const epic = makeTicket({ id: 10, isEpic: true, priority: null });
    expect(planSpinOff(makeTicket({ epicId: 10, priority: 'P2' }), epic).priority).toBeNull();
  });
});
