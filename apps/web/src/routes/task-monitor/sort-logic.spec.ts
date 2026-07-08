import { describe, it, expect } from 'vitest';
import { compareTicketsInColumn } from './sort-logic';
import type { AgentTicket } from '@dashboard/shared';

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
    refineState: null,
    refined: false,
    isEpic: false,
    epicId: null,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('compareTicketsInColumn', () => {
  describe('completed column — sort by recency', () => {
    it('puts the more recently updated ticket first', () => {
      const older = makeTicket({ id: 1, updatedAt: 1000 });
      const newer = makeTicket({ id: 2, updatedAt: 2000 });
      expect(compareTicketsInColumn('completed', newer, older)).toBeLessThan(0);
      expect(compareTicketsInColumn('completed', older, newer)).toBeGreaterThan(0);
    });

    it('returns 0 when updatedAt is equal', () => {
      const a = makeTicket({ updatedAt: 5000 });
      const b = makeTicket({ updatedAt: 5000 });
      expect(compareTicketsInColumn('completed', a, b)).toBe(0);
    });

    it('ignores priority', () => {
      const lowPrioNewer = makeTicket({ priority: 'P5', updatedAt: 9000 });
      const highPrioOlder = makeTicket({ priority: 'P0', updatedAt: 1000 });
      expect(compareTicketsInColumn('completed', lowPrioNewer, highPrioOlder)).toBeLessThan(0);
    });
  });

  describe('closed column — sort by recency', () => {
    it('puts the more recently updated ticket first', () => {
      const older = makeTicket({ id: 1, updatedAt: 3000 });
      const newer = makeTicket({ id: 2, updatedAt: 9000 });
      expect(compareTicketsInColumn('closed', newer, older)).toBeLessThan(0);
      expect(compareTicketsInColumn('closed', older, newer)).toBeGreaterThan(0);
    });
  });

  describe('other columns — sort by priority then sort_order', () => {
    it('puts higher priority (lower P-number) first', () => {
      const p0 = makeTicket({ priority: 'P0', sortOrder: 100 });
      const p1 = makeTicket({ priority: 'P1', sortOrder: 0 });
      expect(compareTicketsInColumn('backlog', p0, p1)).toBeLessThan(0);
      expect(compareTicketsInColumn('prioritized', p1, p0)).toBeGreaterThan(0);
    });

    it('sorts by sortOrder within the same priority band', () => {
      const first = makeTicket({ priority: 'P2', sortOrder: 10 });
      const second = makeTicket({ priority: 'P2', sortOrder: 20 });
      expect(compareTicketsInColumn('robot_queue', first, second)).toBeLessThan(0);
    });

    it('places unset priority after all explicit levels', () => {
      const p5 = makeTicket({ priority: 'P5', sortOrder: 0 });
      const unset = makeTicket({ priority: null, sortOrder: 0 });
      expect(compareTicketsInColumn('steve_queue', p5, unset)).toBeLessThan(0);
      expect(compareTicketsInColumn('robot_queue', unset, p5)).toBeGreaterThan(0);
    });

    it('returns 0 for equal priority and sortOrder', () => {
      const a = makeTicket({ priority: 'P3', sortOrder: 5 });
      const b = makeTicket({ priority: 'P3', sortOrder: 5 });
      expect(compareTicketsInColumn('backlog', a, b)).toBe(0);
    });
  });
});
