import { describe, it, expect } from 'vitest';
import { compareTicketsInColumn, compareEpicsInLane, rankOf } from './sort-logic';
import { rankOf as rankOfFromDrag, PRIORITY_RANK as RANK_FROM_DRAG } from './board-drag';
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
      expect(compareTicketsInColumn('backlog', p1, p0)).toBeGreaterThan(0);
    });

    it('sorts by sortOrder within the same priority band', () => {
      const first = makeTicket({ priority: 'P2', sortOrder: 10 });
      const second = makeTicket({ priority: 'P2', sortOrder: 20 });
      expect(compareTicketsInColumn('queue', first, second)).toBeLessThan(0);
    });

    it('places unset priority after all explicit levels', () => {
      const p5 = makeTicket({ priority: 'P5', sortOrder: 0 });
      const unset = makeTicket({ priority: null, sortOrder: 0 });
      expect(compareTicketsInColumn('queue', p5, unset)).toBeLessThan(0);
      expect(compareTicketsInColumn('queue', unset, p5)).toBeGreaterThan(0);
    });

    it('returns 0 for equal priority and sortOrder', () => {
      const a = makeTicket({ priority: 'P3', sortOrder: 5 });
      const b = makeTicket({ priority: 'P3', sortOrder: 5 });
      expect(compareTicketsInColumn('backlog', a, b)).toBe(0);
    });
  });
});

/**
 * PD-538. The Epic band sorted by `sortOrder` alone and never looked at priority, so a P4 Epic
 * could sit above a P1 purely because it had been dragged there — an order the loop would not
 * follow. These pin the rule against the loop's own `ORDER BY`.
 */
describe('compareEpicsInLane', () => {
  const epic = (o: Partial<AgentTicket> = {}) => makeTicket({ isEpic: true, ...o });

  describe('pending lanes — dispatch order', () => {
    it('puts higher priority first, whatever the drag order says', () => {
      const p1DraggedLow = epic({ id: 1, priority: 'P1', sortOrder: 900 });
      const p4DraggedHigh = epic({ id: 2, priority: 'P4', sortOrder: 0 });
      expect(compareEpicsInLane('backlog', p1DraggedLow, p4DraggedHigh)).toBeLessThan(0);
      expect(compareEpicsInLane('in_progress', p1DraggedLow, p4DraggedHigh)).toBeLessThan(0);
    });

    it('falls back to sortOrder only within one priority', () => {
      const first = epic({ id: 1, priority: 'P2', sortOrder: 1 });
      const second = epic({ id: 2, priority: 'P2', sortOrder: 2 });
      expect(compareEpicsInLane('backlog', first, second)).toBeLessThan(0);
    });

    it('sorts unset priority last', () => {
      const p5 = epic({ id: 1, priority: 'P5', sortOrder: 10 });
      const unset = epic({ id: 2, priority: null, sortOrder: 0 });
      expect(compareEpicsInLane('backlog', p5, unset)).toBeLessThan(0);
    });

    // A non-total order lets two cards swap places between renders, which reads as the board
    // twitching on its own.
    it('breaks a full tie by id, so the order is total', () => {
      const a = epic({ id: 3, priority: 'P1', sortOrder: 0 });
      const b = epic({ id: 7, priority: 'P1', sortOrder: 0 });
      expect(compareEpicsInLane('backlog', a, b)).toBeLessThan(0);
      expect(compareEpicsInLane('backlog', b, a)).toBeGreaterThan(0);
    });

    it('agrees with the Ticket band on the same pair', () => {
      const a = epic({ id: 1, priority: 'P0', sortOrder: 99 });
      const b = epic({ id: 2, priority: 'P3', sortOrder: 0 });
      expect(Math.sign(compareEpicsInLane('backlog', a, b))).toBe(
        Math.sign(compareTicketsInColumn('backlog', a, b)),
      );
    });
  });

  // Nothing in a terminal lane is going to be dispatched, so priority has stopped being the
  // question; "what finished most recently" is what those lanes get asked. Matches the Ticket band.
  describe('terminal lanes — recency', () => {
    it('puts the more recently updated Epic first, ignoring priority', () => {
      const lowPrioNewer = epic({ id: 1, priority: 'P5', updatedAt: 9000 });
      const highPrioOlder = epic({ id: 2, priority: 'P0', updatedAt: 1000 });
      for (const lane of ['completed', 'closed'] as const) {
        expect(compareEpicsInLane(lane, lowPrioNewer, highPrioOlder)).toBeLessThan(0);
      }
    });

    it('still breaks ties by id', () => {
      const a = epic({ id: 4, updatedAt: 500 });
      const b = epic({ id: 9, updatedAt: 500 });
      expect(compareEpicsInLane('completed', a, b)).toBeLessThan(0);
    });
  });
});

// PD-538 collapsed two identical copies of the priority ranking into one. They agreed at the time,
// which is the only reason nothing had broken; this makes a future divergence impossible rather
// than merely unlikely.
describe('priority rank has exactly one definition', () => {
  it('board-drag re-exports sort-logic’s, not a copy of it', () => {
    expect(rankOfFromDrag).toBe(rankOf);
    expect(RANK_FROM_DRAG.P0).toBe(0);
    expect(RANK_FROM_DRAG.none).toBe(6);
  });
});
