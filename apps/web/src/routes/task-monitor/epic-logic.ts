import type { AgentTicket, EpicDerivedLane, EpicSummary, TicketStatus } from '@dashboard/shared';

/** A cell in the board's Epic band (D-054, PD-337): the Epics whose derived lane maps to a
 *  contiguous run of visible ticket columns. `in_progress` spans the two queue columns. */
export interface EpicBandCell {
  lane: EpicDerivedLane;
  label: string;
  /** 1-based grid column start + span among the *visible* columns. */
  colStart: number;
  colSpan: number;
  /** Epic `+` button shows only in Backlog / Prioritized (new Epics start there). */
  canAdd: boolean;
  epics: AgentTicket[];
}

const LANE_LABEL: Record<EpicDerivedLane, string> = {
  backlog: 'Backlog',
  prioritized: 'Prioritized',
  in_progress: 'In Progress',
  completed: 'Completed',
  closed: 'Closed',
};

/** Ticket-lane statuses each derived Epic lane sits over (in board order). `in_progress` collapses
 *  Steve's + Robot's queues (D-054) — an Epic is never *in* a queue, only over it. */
const LANE_COLUMNS: Record<EpicDerivedLane, TicketStatus[]> = {
  backlog: ['backlog'],
  prioritized: ['prioritized'],
  in_progress: ['steve_queue', 'robot_queue'],
  completed: ['completed'],
  closed: ['closed'],
};

const EPIC_LANES: EpicDerivedLane[] = [
  'backlog',
  'prioritized',
  'in_progress',
  'completed',
  'closed',
];

/** Build the Epic band's cells over the given visible columns. A lane whose columns are all hidden
 *  is dropped (its Epics hide with the lane); `in_progress` narrows to whichever queue columns are
 *  visible. Backlog/Prioritized always render (even empty) so their `+` button is reachable. */
export function buildEpicBand(
  epics: AgentTicket[],
  summaryById: Map<number, EpicSummary>,
  visibleStatuses: TicketStatus[],
): EpicBandCell[] {
  const colIndex = new Map<TicketStatus, number>(visibleStatuses.map((s, i) => [s, i + 1]));
  const byLane = new Map<EpicDerivedLane, AgentTicket[]>();
  // Order epics within a cell purely by sortOrder (then id) so hand-reordering (D-054 amended)
  // is stable — independent of the server list's status-first sort.
  const ordered = [...epics].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  for (const e of ordered) {
    const lane = summaryById.get(e.id)?.derivedLane ?? 'backlog';
    const list = byLane.get(lane);
    if (list) list.push(e);
    else byLane.set(lane, [e]);
  }
  const cells: EpicBandCell[] = [];
  for (const lane of EPIC_LANES) {
    const cols = LANE_COLUMNS[lane]
      .map((s) => colIndex.get(s))
      .filter((x): x is number => x != null);
    if (cols.length === 0) continue; // all mapped columns hidden → skip
    cells.push({
      lane,
      label: LANE_LABEL[lane],
      colStart: Math.min(...cols),
      colSpan: cols.length, // contiguous by construction
      canAdd: lane === 'backlog' || lane === 'prioritized',
      epics: byLane.get(lane) ?? [],
    });
  }
  return cells;
}
