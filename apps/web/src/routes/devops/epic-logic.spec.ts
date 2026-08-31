import { describe, it, expect } from 'vitest';
import { buildEpicBand } from './epic-logic';
import type { AgentTicket, EpicDerivedLane, EpicSummary, TicketStatus } from '@dashboard/shared';

/**
 * `buildEpicBand` had no tests (PD-538). It decides both the geometry of the Epic band and the
 * order Epics read in, and the ordering half was wrong for as long as D-080 has existed — the band
 * ranked by drag order alone while the loop dispatches by priority. Nothing failed, because nothing
 * looked.
 */

function epic(o: Partial<AgentTicket> = {}): AgentTicket {
  return {
    id: 1,
    displayId: 'PD-1',
    projectId: 1,
    title: 'An epic',
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
    isEpic: true,
    epicId: null,
    ready: false,
    readyBypassed: false,
    archivedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...o,
  };
}

function summaries(pairs: [number, EpicDerivedLane][]): Map<number, EpicSummary> {
  return new Map(
    pairs.map(([ticketId, derivedLane]) => [
      ticketId,
      { ticketId, derivedLane, total: 0, done: 0 } as EpicSummary,
    ]),
  );
}

const ALL_COLUMNS: TicketStatus[] = ['backlog', 'queue', 'completed', 'closed'];

/** Epic ids in the given lane, in the order the band would render them. */
function laneOrder(
  epics: AgentTicket[],
  map: Map<number, EpicSummary>,
  lane: EpicDerivedLane,
  columns: TicketStatus[] = ALL_COLUMNS,
): number[] {
  const cell = buildEpicBand(epics, map, columns).find((c) => c.lane === lane);
  return (cell?.epics ?? []).map((e) => e.id);
}

describe('buildEpicBand — ordering (PD-538)', () => {
  it('ranks by priority first, not by drag order', () => {
    const epics = [
      epic({ id: 1, priority: 'P4', sortOrder: 0 }),
      epic({ id: 2, priority: 'P1', sortOrder: 50 }),
      epic({ id: 3, priority: 'P0', sortOrder: 99 }),
    ];
    const map = summaries([
      [1, 'backlog'],
      [2, 'backlog'],
      [3, 'backlog'],
    ]);
    expect(laneOrder(epics, map, 'backlog')).toEqual([3, 2, 1]);
  });

  it('keeps drag order as the tie-break inside one priority', () => {
    const epics = [
      epic({ id: 1, priority: 'P2', sortOrder: 30 }),
      epic({ id: 2, priority: 'P2', sortOrder: 10 }),
      epic({ id: 3, priority: 'P2', sortOrder: 20 }),
    ];
    const map = summaries([
      [1, 'backlog'],
      [2, 'backlog'],
      [3, 'backlog'],
    ]);
    expect(laneOrder(epics, map, 'backlog')).toEqual([2, 3, 1]);
  });

  it('puts unpriced Epics last', () => {
    const epics = [
      epic({ id: 1, priority: null, sortOrder: 0 }),
      epic({ id: 2, priority: 'P5', sortOrder: 100 }),
    ];
    const map = summaries([
      [1, 'backlog'],
      [2, 'backlog'],
    ]);
    expect(laneOrder(epics, map, 'backlog')).toEqual([2, 1]);
  });

  it('orders each lane independently', () => {
    const epics = [
      epic({ id: 1, priority: 'P3', sortOrder: 0 }),
      epic({ id: 2, priority: 'P0', sortOrder: 0 }),
      epic({ id: 3, priority: 'P2', sortOrder: 0 }),
      epic({ id: 4, priority: 'P1', sortOrder: 0 }),
    ];
    const map = summaries([
      [1, 'backlog'],
      [2, 'in_progress'],
      [3, 'backlog'],
      [4, 'in_progress'],
    ]);
    expect(laneOrder(epics, map, 'backlog')).toEqual([3, 1]);
    expect(laneOrder(epics, map, 'in_progress')).toEqual([2, 4]);
  });

  // Terminal lanes answer "what finished most recently", not "what runs next".
  it('orders the terminal lanes by recency instead', () => {
    const epics = [
      epic({ id: 1, priority: 'P0', updatedAt: 100 }),
      epic({ id: 2, priority: 'P5', updatedAt: 900 }),
    ];
    const map = summaries([
      [1, 'completed'],
      [2, 'completed'],
    ]);
    expect(laneOrder(epics, map, 'completed')).toEqual([2, 1]);
  });

  it('treats an Epic with no summary as Backlog', () => {
    const epics = [epic({ id: 1, priority: 'P1' })];
    expect(laneOrder(epics, new Map(), 'backlog')).toEqual([1]);
  });
});

describe('buildEpicBand — geometry', () => {
  it('places each lane over its own columns', () => {
    const cells = buildEpicBand([], new Map(), ALL_COLUMNS);
    const at = (lane: EpicDerivedLane) => cells.find((c) => c.lane === lane)!;
    expect(at('backlog').colStart).toBe(1);
    expect(at('in_progress').colStart).toBe(2);
    expect(at('completed').colStart).toBe(3);
    expect(at('closed').colStart).toBe(4);
    for (const c of cells) expect(c.colSpan).toBe(1);
  });

  it('drops a lane whose columns are all hidden, and re-indexes the rest', () => {
    const cells = buildEpicBand([], new Map(), ['backlog', 'completed']);
    expect(cells.map((c) => c.lane)).toEqual(['backlog', 'completed']);
    expect(cells.find((c) => c.lane === 'completed')!.colStart).toBe(2);
  });

  // D-080: new Epics start in Backlog, so that is the only lane offering a `+`.
  it('offers the add button in Backlog only', () => {
    const cells = buildEpicBand([], new Map(), ALL_COLUMNS);
    expect(cells.filter((c) => c.canAdd).map((c) => c.lane)).toEqual(['backlog']);
  });

  // PD-536: the cell sits over the `queue` column and carries that column's name.
  it('labels the in_progress lane "Queue"', () => {
    const cells = buildEpicBand([], new Map(), ALL_COLUMNS);
    expect(cells.find((c) => c.lane === 'in_progress')!.label).toBe('Queue');
  });
});
