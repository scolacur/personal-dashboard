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
  summary: 'Lane for newly created and unrefined tickets.',
  bullets: [
    'Tickets added to an already-queued Epic are put here, as are reopened terminal tickets.',
    'Autonomous agents may only ever create into the Backlog.',
  ],
};

// Read from `robotQueueCandidates` in agent-worker/src/jobs/robot/select.ts, in the query's order.
const QUEUE: LaneHelp = {
  summary:
    'Move an Epic here when you are ready to work on it, and its tickets get queued automatically.',
  bullets: [
    'Queued tickets are picked up by a Robot when they are assigned to the Robot;',
    'formatted, or marked formatting-bypassed;',
    'not blocked by an open `blocks` relation;',
    'in a Robot-enabled project with a GitHub repo;',
    'not archived;',
    'and the agent state is empty or "waiting" — i.e. the number of Robots currently working is below the max concurrent Robots.',
  ],
  footnote:
    'Order: priority (unset last), then the Epic\'s drag order, then the ticket\'s drag order within its Epic, then id.',
};

const COMPLETED: LaneHelp = {
  summary: 'Finished work. Set by the loop when a PR merges, or by hand for anything done manually.',
  bullets: ['Completed and closed tickets are read-only — reopen one from its own page.'],
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
