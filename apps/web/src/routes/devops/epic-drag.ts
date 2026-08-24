import type { AgentTicket, EpicDerivedLane, TicketStatus } from '@dashboard/shared';

/**
 * Dragging an Epic between lanes (D-080, PD-508 slice B).
 *
 * Under D-054 an Epic's lane was wholly derived and the Epic band was not a drop target. D-080
 * splits that by direction: the *pending* lanes are now driven by the Epic's own status, because
 * queueing the Epic is how work is dispatched, while `completed`/`closed` stay derived — those are
 * observations of what the loop actually did, and no top-down drag may assert them.
 *
 * The server owns the cascade (store.ts `updateTicket`); this module is the board's read-side model
 * of it, so the UI can say what a drop will do *before* it happens. Kept out of the component
 * because `apps/web` has no component-rendering tests — logic that lives here gets covered.
 */

/** The only lanes an Epic may be dragged into. */
export const DRAGGABLE_EPIC_LANES: readonly EpicDerivedLane[] = ['backlog', 'in_progress'] as const;

export function isDraggableEpicLane(lane: EpicDerivedLane): boolean {
  return DRAGGABLE_EPIC_LANES.includes(lane);
}

/** The Epic's own `status` for a draggable lane. */
export function statusForEpicLane(lane: EpicDerivedLane): TicketStatus | null {
  if (lane === 'backlog') return 'backlog';
  if (lane === 'in_progress') return 'queue';
  return null;
}

/** An Epic's live members — everything pointing at it, terminal rows included. */
export function membersOf(epicId: number, tickets: AgentTicket[]): AgentTicket[] {
  return tickets.filter((t) => t.epicId === epicId);
}

/** A member is terminal when the work is over; a rollback never touches these. */
function isTerminal(m: AgentTicket): boolean {
  return m.status === 'completed' || m.status === 'closed';
}

/**
 * Agent states that mean work is genuinely in flight, so the ticket must be left where it is:
 *
 *  - `working`    — a live coding session. It cannot be stopped from here at all (see below).
 *  - `in-review`  — no session is running, but a PR is open and `pollInReviewPrs` is watching it,
 *                   and that poll is scoped to `status = 'queue'`. Moving the ticket to Backlog
 *                   would strand an open PR that nothing is watching any more.
 *
 * The parked states (`stuck` / `needs-human` / `awaiting-human`) are deliberately NOT here: nothing
 * is in flight for those, so they come back with the Epic.
 */
export const IN_FLIGHT_AGENT_STATES: readonly string[] = ['working', 'in-review'] as const;

export function isInFlight(m: AgentTicket): boolean {
  return m.status === 'queue' && m.agentState !== null && IN_FLIGHT_AGENT_STATES.includes(m.agentState);
}

// ── Queueing ────────────────────────────────────────────────────────────────

export interface EpicQueuePlan {
  /** Members the server will arm. Mirrors its `status = 'backlog'` cascade — `completed`/`closed`
   *  members are deliberately left alone, because a half-done Epic is the normal in-flight state. */
  armed: AgentTicket[];
  /** Armed, robot-assigned, and shaped — the loop can pick these up on its next cycle. */
  dispatchable: AgentTicket[];
  /**
   * Armed and robot-assigned but NOT shaped. The loop's candidate query gates on
   * `(ready = 1 OR ready_bypassed = 1)`, which the Epic cascade does not check, so these sit in the
   * Queue looking perfectly normal and never run — the PD-467 failure mode.
   */
  notReady: AgentTicket[];
  /** Armed but not the Robot's to take. Counted separately so `dispatchable + notReady` can't
   *  quietly under-report the total the human just queued. */
  human: AgentTicket[];
}

export function planEpicQueue(members: AgentTicket[]): EpicQueuePlan {
  const armed = members.filter((m) => m.status === 'backlog');
  const robot = armed.filter((m) => m.assignee === 'robot');
  return {
    armed,
    dispatchable: robot.filter((m) => m.ready || m.readyBypassed),
    notReady: robot.filter((m) => !m.ready && !m.readyBypassed),
    human: armed.filter((m) => m.assignee !== 'robot'),
  };
}

// ── Rollback ────────────────────────────────────────────────────────────────

export interface EpicRollbackPlan {
  /**
   * Members with work in flight. **Nothing on this board can stop them** — the loop runs sessions
   * sequentially and awaits each one with no cancel channel, and D-046 holds that ending a Robot
   * mid-hand-off loses the work outright. They stay in the Queue.
   */
  inFlight: AgentTicket[];
  /** Everything that returns to Backlog: queued, not terminal, not in flight. */
  pullBack: AgentTicket[];
  /**
   * Whether the Epic's own status moves.
   *
   * This is the fix for the bug where a rollback "did nothing": the Epic's lane is derived, and
   * `deriveEpicLane` reports `in_progress` whenever ANY member sits in `queue`. So moving the Epic
   * to `backlog` while a run is live wrote a status the view immediately overruled — the card never
   * moved, and the Epic was left quietly disagreeing with its own lane. When work is in flight the
   * Epic now stays in the Queue, which is simply the truth.
   */
  movesEpic: boolean;
}

export function planEpicRollback(members: AgentTicket[]): EpicRollbackPlan {
  const inFlight = members.filter(isInFlight);
  return {
    inFlight,
    pullBack: members.filter((m) => m.status === 'queue' && !isTerminal(m) && !isInFlight(m)),
    movesEpic: inFlight.length === 0,
  };
}

/** The modal appears only to report work that cannot be recalled. Otherwise: silent and instant. */
export function rollbackNeedsConfirm(plan: EpicRollbackPlan): boolean {
  return plan.inFlight.length > 0;
}

/**
 * Title for the Epic that in-flight work is bumped into.
 *
 * The bump exists because a run cannot be stopped: rather than telling the human their Epic is
 * pinned to the Queue by one live ticket, the live ticket gets its own Epic and the rest of the
 * Epic goes back to Backlog. The Epic is the unit of dispatch (D-080), so scheduling two
 * halves differently *requires* two Epics — the split is the model working, not a workaround.
 *
 * Preserves an existing `[Epic]` prefix rather than assuming one; board titles use it
 * inconsistently, and inventing one would rename half the board's conventions by accident.
 */
export function splitEpicTitle(title: string): string {
  const m = /^(\[Epic\]\s*)?([\s\S]*)$/.exec(title);
  const prefix = m?.[1] ?? '';
  const rest = (m?.[2] ?? title).trim();
  return `${prefix}${rest} — active work`;
}
