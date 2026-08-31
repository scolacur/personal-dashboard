import type { AgentTicket, EpicDerivedLane, EpicSummary, TicketStatus } from '@dashboard/shared';
import { compareEpicsInLane } from './sort-logic';

/** A cell in the board's Epic band (D-054, PD-337): the Epics whose derived lane maps to a
 *  contiguous run of visible ticket columns. `in_progress` sits over the single `queue` column
 *  (D-058, collapsed from the old two-queue span). */
export interface EpicBandCell {
  lane: EpicDerivedLane;
  label: string;
  /** 1-based grid column start + span among the *visible* columns. */
  colStart: number;
  colSpan: number;
  /** Epic `+` button shows only in Backlog (D-080: new Epics start there). */
  canAdd: boolean;
  epics: AgentTicket[];
}

// PD-536: the `in_progress` cell is drawn directly over the `queue` column, so it carries that
// column's name. It used to read "In Progress", which both disagreed with the header above it and
// collided with the `working` pill's own "in progress". The lane KEY stays `in_progress` — it is a
// derived-lane identifier, not a label.
const LANE_LABEL: Record<EpicDerivedLane, string> = {
  backlog: 'Backlog',
  in_progress: 'Queue',
  completed: 'Completed',
  closed: 'Closed',
};

/** Ticket-lane statuses each Epic lane sits over (in board order). `in_progress` sits over the
 *  single `queue` column (D-058). D-080: an Epic now genuinely *is* in that lane rather than only
 *  spanning it — queueing the Epic is what dispatches its members. */
const LANE_COLUMNS: Record<EpicDerivedLane, TicketStatus[]> = {
  backlog: ['backlog'],
  in_progress: ['queue'],
  completed: ['completed'],
  closed: ['closed'],
};

const EPIC_LANES: EpicDerivedLane[] = [
  'backlog',
  'in_progress',
  'completed',
  'closed',
];

/** Build the Epic band's cells over the given visible columns. A lane whose columns are all hidden
 *  is dropped (its Epics hide with the lane); `in_progress` narrows to whichever queue columns are
 *  visible. Backlog always renders (even empty) so its `+` button is reachable. */
export function buildEpicBand(
  epics: AgentTicket[],
  summaryById: Map<number, EpicSummary>,
  visibleStatuses: TicketStatus[],
): EpicBandCell[] {
  const colIndex = new Map<TicketStatus, number>(visibleStatuses.map((s, i) => [s, i + 1]));
  const byLane = new Map<EpicDerivedLane, AgentTicket[]>();
  // Bucket first, then sort each lane — the comparator is per-lane (PD-538), because the terminal
  // lanes order by recency while the pending ones order by priority. Sorting the flat list up front
  // could not express that.
  for (const e of epics) {
    const lane = summaryById.get(e.id)?.derivedLane ?? 'backlog';
    const list = byLane.get(lane);
    if (list) list.push(e);
    else byLane.set(lane, [e]);
  }
  // PD-538: priority leads, `sortOrder` ranks Epics of equal priority, `id` makes the order total.
  // Until now this was `sortOrder` alone — right under D-054, when an Epic's lane was derived and
  // hand-ordering was the only signal the band carried, and wrong under D-080, which made the Epic
  // the unit of priority and dispatch. The band was showing an order the loop would not follow.
  for (const [lane, list] of byLane) {
    list.sort((a, b) => compareEpicsInLane(lane, a, b));
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
      canAdd: lane === 'backlog',
      epics: byLane.get(lane) ?? [],
    });
  }
  return cells;
}
