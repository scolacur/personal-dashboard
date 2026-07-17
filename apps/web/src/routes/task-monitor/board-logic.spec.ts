import { describe, it, expect } from 'vitest';
import type { AgentTicket, TicketPriority } from '@dashboard/shared';
import { isStatusLocked, computeSortOrder, clampEpicHeight, EPIC_HEIGHT_MIN, EPIC_HEIGHT_MAX } from './board-logic';

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

describe('isStatusLocked', () => {
  it('locks a robot-owned ticket in an agent-controlled lane', () => {
    expect(isStatusLocked(makeTicket({ assignee: 'robot', status: 'robot_queue' }))).toBe(true);
    expect(isStatusLocked(makeTicket({ assignee: 'robot', status: 'completed' }))).toBe(true);
  });

  it('does not lock a robot-owned ticket outside an agent-controlled lane', () => {
    expect(isStatusLocked(makeTicket({ assignee: 'robot', status: 'backlog' }))).toBe(false);
    expect(isStatusLocked(makeTicket({ assignee: 'robot', status: 'prioritized' }))).toBe(false);
    expect(isStatusLocked(makeTicket({ assignee: 'robot', status: 'steve_queue' }))).toBe(false);
  });

  it('does not lock a ticket in an agent-controlled lane unless robot owns it', () => {
    expect(isStatusLocked(makeTicket({ assignee: 'steve', status: 'robot_queue' }))).toBe(false);
    expect(isStatusLocked(makeTicket({ assignee: null, status: 'completed' }))).toBe(false);
  });
});

describe('computeSortOrder', () => {
  // Helper: a column band of same-priority cards with the given sort orders.
  function band(sortOrders: number[], priority: TicketPriority | null = 'P1'): AgentTicket[] {
    return sortOrders.map((sortOrder, i) => makeTicket({ id: i + 1, priority, sortOrder }));
  }

  it('returns 0 for an empty band', () => {
    expect(computeSortOrder([], 'P1', null, 99)).toBe(0);
  });

  it('appends past the end when beforeId is null', () => {
    // ids 1,2,3 with sortOrders 0,1,2 → dropping at end → last.sortOrder + 1
    expect(computeSortOrder(band([0, 1, 2]), 'P1', null, 99)).toBe(3);
  });

  it('places before the first card', () => {
    // beforeId = id 1 (first) → no prev → next.sortOrder - 1
    expect(computeSortOrder(band([0, 1, 2]), 'P1', 1, 99)).toBe(-1);
  });

  it('places between two cards using the midpoint', () => {
    // beforeId = id 2 (sortOrder 1) → prev is id 1 (sortOrder 0) → (0 + 1) / 2
    expect(computeSortOrder(band([0, 1, 2]), 'P1', 2, 99)).toBe(0.5);
  });

  it('excludes the dragged card from the band', () => {
    // Drag id 2 (sortOrder 1) to before id 3 (sortOrder 2). With id 2 removed the
    // band is [id1=0, id3=2]; before id3 → prev id1=0, next id3=2 → midpoint 1.
    expect(computeSortOrder(band([0, 1, 2]), 'P1', 3, 2)).toBe(1);
  });

  it('only considers cards in the dragged card priority band', () => {
    const mixed = [
      makeTicket({ id: 1, priority: 'P1', sortOrder: 0 }),
      makeTicket({ id: 2, priority: 'P2', sortOrder: 10 }),
      makeTicket({ id: 3, priority: 'P1', sortOrder: 1 }),
    ];
    // Dropping a P1 card at the end of the P1 band ignores the P2 card entirely.
    expect(computeSortOrder(mixed, 'P1', null, 99)).toBe(2);
  });

  it('treats a beforeId outside the band as append', () => {
    // beforeId points at a card not in the P1 band → findIndex -1 → append.
    expect(computeSortOrder(band([0, 1, 2]), 'P1', 999, 99)).toBe(3);
  });

  it('handles the null (unset) priority band', () => {
    const b = band([0, 1], null);
    expect(computeSortOrder(b, null, null, 99)).toBe(2);
  });
});

describe('clampEpicHeight', () => {
  it('passes through heights within the valid range', () => {
    expect(clampEpicHeight(200)).toBe(200);
    expect(clampEpicHeight(EPIC_HEIGHT_MIN)).toBe(EPIC_HEIGHT_MIN);
    expect(clampEpicHeight(EPIC_HEIGHT_MAX)).toBe(EPIC_HEIGHT_MAX);
  });

  it('clamps values below the minimum to EPIC_HEIGHT_MIN', () => {
    expect(clampEpicHeight(0)).toBe(EPIC_HEIGHT_MIN);
    expect(clampEpicHeight(-100)).toBe(EPIC_HEIGHT_MIN);
    expect(clampEpicHeight(EPIC_HEIGHT_MIN - 1)).toBe(EPIC_HEIGHT_MIN);
  });

  it('clamps values above the maximum to EPIC_HEIGHT_MAX', () => {
    expect(clampEpicHeight(EPIC_HEIGHT_MAX + 1)).toBe(EPIC_HEIGHT_MAX);
    expect(clampEpicHeight(9999)).toBe(EPIC_HEIGHT_MAX);
  });
});
