import type { TicketStatus } from '@dashboard/shared';

/**
 * What each board lane actually means (PD-517).
 *
 * The lanes carry rules that are invisible on the surface, and the Queue's are the worst of it:
 * a card sitting in the Queue is **not** necessarily going to be picked up, and the reasons are
 * spread across `robotQueueCandidates` (agent-worker `jobs/robot/select.ts`), the Epic cascade in
 * the server's `updateTicket`, and the `agent_state` machine. Until now the only way to find out
 * why a card was sitting still was to read the code. A lane header is where the question gets
 * asked, so it is where the answer belongs.
 *
 * **Every Queue line below was read off the query, not recalled.** If `robotQueueCandidates`
 * changes, this is stale, and `lane-help.spec.ts` will not catch it — a test cannot compare prose
 * against SQL in another workspace. The guard is that the conditions are listed in the query's own
 * order, so a diff of the two reads side by side.
 */

export interface LaneHelp {
  /** One sentence: what this lane *is*. */
  summary: string;
  /** The rules, each short enough to scan. Empty when the summary says everything. */
  bullets: string[];
  /** Shown last, in a quieter style — the caveat people are actually surprised by. */
  footnote?: string;
}

const BACKLOG: LaneHelp = {
  summary: 'The default lane. Everything starts here, and nothing is dispatched from here.',
  bullets: [
    'A Ticket leaves Backlog when its Epic is queued — not by being dragged on its own.',
    'A new member of an already-queued Epic lands here deliberately, so joining live work stays an explicit act.',
  ],
  footnote: 'Autonomous agents may only ever create into Backlog.',
};

// Read from `robotQueueCandidates` in agent-worker/src/jobs/robot/select.ts, in the query's order.
const QUEUE: LaneHelp = {
  summary:
    'Armed, not launched. A card here is a candidate the Robot loop considers — every condition below must also hold before it runs.',
  bullets: [
    'Assigned to the Robot. A queued ticket assigned to Steve is a personal to-do and is never dispatched; unassigned is never dispatched either.',
    'Ready — the four-section body check — or explicitly Ready-bypassed.',
    'Not blocked by an open `blocks` relation. A blocked card is skipped at selection, not refused entry to the lane.',
    'Its project is Robot-enabled and has a GitHub repo.',
    'Its agent state is empty or "waiting". Anything already in progress or in review is in flight, not a candidate.',
    'Not archived.',
  ],
  footnote:
    'Order: priority (unset last), then the Epic\'s drag order, then the member\'s drag order within its Epic, then id. Queueing an Epic arms all of its members; the concurrency cap means they start one at a time, not all at once.',
};

const COMPLETED: LaneHelp = {
  summary: 'Finished work. Set by the loop when a PR merges, or by hand for anything not robot-run.',
  bullets: [
    'Completed and closed tickets are read-only — leaving either is a deliberate Reopen on the ticket itself.',
    "An Epic's lane is derived from its members, so an Epic lands here once they all have.",
  ],
};

const CLOSED: LaneHelp = {
  summary: 'Work that ended without being done — dropped, superseded, or split into other tickets.',
  bullets: [
    'A decomposed parent is closed automatically and linked to the children that replaced it.',
    'Read-only, exactly like Completed: reopening is deliberate and happens on the ticket.',
  ],
};

const HELP: Record<TicketStatus, LaneHelp> = {
  backlog: BACKLOG,
  queue: QUEUE,
  completed: COMPLETED,
  closed: CLOSED,
};

/** The help for a lane. Total over `TicketStatus`, so a new lane is a compile error, not a gap. */
export function laneHelp(status: TicketStatus): LaneHelp {
  return HELP[status];
}

/** Flattened to one string for a `title=` fallback and for the accessible description. */
export function laneHelpText(status: TicketStatus): string {
  const h = HELP[status];
  return [h.summary, ...h.bullets.map((b) => `• ${b}`), ...(h.footnote ? [h.footnote] : [])].join(
    '\n',
  );
}
