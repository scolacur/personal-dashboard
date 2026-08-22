import type { AgentTicket, EpicDerivedLane, TicketStatus } from '@dashboard/shared';

/**
 * Dragging an Epic between lanes (D-TMP-PD383a, PD-508 slice B).
 *
 * Under D-054 an Epic's lane was wholly derived and the Epic band was not a drop target. D-TMP-PD383a
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

// ── Queueing ────────────────────────────────────────────────────────────────

export interface EpicQueuePlan {
  /** Members the server will arm. Mirrors its `status = 'backlog'` cascade — `completed`/`closed`
   *  members are deliberately left alone, because a half-done Epic is the normal in-flight state. */
  willQueue: AgentTicket[];
  /**
   * Of those, the ones the Robot loop will never actually pick up: its candidate query gates on
   * `(ready = 1 OR ready_bypassed = 1)`, which the Epic cascade does not check. They are not
   * dangerous — nothing unshaped gets dispatched — but they would sit in the Queue looking normal
   * and never run, which is the PD-467 failure mode. Surfaced so the dead end is not silent.
   */
  notReady: AgentTicket[];
}

export function planEpicQueue(members: AgentTicket[]): EpicQueuePlan {
  const willQueue = members.filter((m) => m.status === 'backlog');
  return {
    willQueue,
    notReady: willQueue.filter((m) => m.assignee === 'robot' && !m.ready && !m.readyBypassed),
  };
}

// ── Rollback ────────────────────────────────────────────────────────────────

export interface EpicRollbackPlan {
  /** Members the server un-queues on its own: queued and never started. */
  unqueued: AgentTicket[];
  /**
   * Members with a live coding session. These cannot be stopped from here — the loop runs sessions
   * sequentially and awaits each one, with no cancel channel, and D-046 is explicit that killing a
   * Robot mid-hand-off loses the work outright. The modal reports them; it does not offer to end
   * them, because no write on this board can.
   */
  running: AgentTicket[];
  /**
   * Members parked mid-flight (in-review / stuck / needs-human / awaiting-human). Nothing is in
   * flight for these, so pulling them back to Backlog is safe — but the server's cascade leaves
   * them in the Queue, since only the human knows whether the Epic is being shelved or nudged.
   * This is the actual question the rollback modal asks.
   */
  parked: AgentTicket[];
}

export function planEpicRollback(members: AgentTicket[]): EpicRollbackPlan {
  const queued = members.filter((m) => m.status === 'queue');
  return {
    // Mirrors the server's `agent_state IS NULL OR agent_state = 'queued'` predicate exactly.
    unqueued: queued.filter((m) => m.agentState === null || m.agentState === 'queued'),
    running: queued.filter((m) => m.agentState === 'working'),
    parked: queued.filter(
      (m) => m.agentState !== null && m.agentState !== 'queued' && m.agentState !== 'working',
    ),
  };
}

/**
 * Whether the rollback has anything to tell the human. Nothing left behind ⇒ the drag is silent and
 * instant, which is the common case (an Epic queued by mistake, or shelved before the loop reached
 * it).
 */
export function rollbackNeedsConfirm(plan: EpicRollbackPlan): boolean {
  return plan.running.length > 0 || plan.parked.length > 0;
}
