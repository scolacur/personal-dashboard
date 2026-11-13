import type { AgentTicket, QueueCriterion, TicketStatus } from '@dashboard/shared';
import { epicQueueCriteria, isReady, queueBlockers, queueEntryRefusals } from '@dashboard/shared';

/**
 * The queue-model invariants, enforced at the HTTP boundary (PD-542).
 *
 * Two rules were previously enforced **only by the board**, so Refine, a stale client, or a `curl`
 * could still produce states the UI prevents:
 *
 *  - **D-083** — a terminal Ticket is read-only, and leaving terminal happens only via an
 *    explicit Reopen.
 *  - **D-080 / PD-509** — a Ticket belongs to an Epic, and never leaves one.
 *
 * **These run at the route layer, not inside `updateTicket`.** That placement is the decision, and
 * it is deliberate:
 *
 *  - The requirement is that *the rules hold against a raw `curl`*. The route layer is exactly the
 *    untrusted boundary; everything past it is the server's own orchestration.
 *  - `createTicket`/`updateTicket` are also called internally — by `approveRefine` (which closes a
 *    decomposed parent, i.e. legitimately enters terminal) and by the recurrence respawn. Guarding
 *    the store would refuse the server's own correct behaviour and force an exemption flag on every
 *    internal call, which is a worse trade than guarding the door.
 *  - The Robot loop is unaffected either way: `apps/agent-worker` makes no HTTP calls and never
 *    imports this store — it opens `dashboard.db` directly with its own SQL. Loop and server are two
 *    independent writers on one table.
 *
 * **The loop does not merely escape these rules; it depends on escaping them.** Its entire
 * ticket-write surface is two statements in `jobs/robot/board.ts` — `setAgentState`, and
 * `completeTicket` on a merged PR. That second one moves the ticket from `queue` (`agent_state =
 * 'in-review'`) to `completed`, which is precisely the transition `RUN_IN_FLIGHT` below refuses. So
 * "move these into `updateTicket` and make them real invariants" is not the safe hardening it looks
 * like: it would refuse PR-merge completion and leave every finished ticket in the Queue. The
 * exemption is structural, not written down, which is why `ticket-guards.spec.ts` pins it.
 *
 * **So this is a guard, not an invariant.** It stops mistakes made through the API; it cannot stop
 * the loop's own SQL, and it is not a security boundary — the board is an unauthenticated LAN
 * service. Attribution of writes is PD-543, and is a separate concern from refusing them.
 */

export interface GuardFailure {
  message: string;
  code: string;
}

function isTerminal(status: TicketStatus): boolean {
  return status === 'completed' || status === 'closed';
}

/**
 * The fields a terminal Ticket will still accept.
 *
 * Terminal is read-only for *content* — title, body, priority, epic, assignee. What remains
 * permitted is bookkeeping the record is allowed to gain after the fact: the GitHub issue link
 * (backfilled by the sync), and archiving. None of it changes what the ticket says was done, which
 * is the thing D-083 exists to protect.
 *
 * **`sortOrder` is here too (PD-590).** It was refused at first, which broke reordering an Epic's
 * member list whenever a completed ticket sat in it — the whole list, not just that row. That was
 * over-reach: `sortOrder` is *where a card sits*, not a claim about what happened. A completed
 * member still occupies a position among its siblings, and moving it rewrites no history. The test
 * for this set is "would changing it alter the record of the work?", and position does not.
 */
const TERMINAL_WRITABLE = new Set(['githubIssueNumber', 'archivedAt', 'sortOrder']);

/**
 * Why this PATCH must be refused, or null when it may proceed.
 *
 * `patch` is the already-validated field set; `existing` is the ticket as stored.
 */
export function patchGuardFailure(
  existing: Pick<AgentTicket, 'status' | 'isEpic' | 'epicId' | 'agentState'>,
  patch: Record<string, unknown>,
): GuardFailure | null {
  const keys = Object.keys(patch);

  // ── D-083: terminal is final ───────────────────────────────────────
  // Epics are exempt, and deliberately so: an Epic's lane is *derived* from its members, so an Epic
  // reading `completed` is a summary of them rather than a state of its own. Freezing it would
  // freeze a value nothing wrote, and un-completing a member already un-completes its Epic.
  if (isTerminal(existing.status) && !existing.isEpic) {
    const wantsOut = 'status' in patch && !isTerminal(patch.status as TicketStatus);
    if (wantsOut) {
      return {
        message:
          'A completed or closed Ticket cannot be moved back by a plain update — reopen it explicitly (POST /tickets/:id/reopen), which also re-attaches an Epic and clears its agent state.',
        code: 'TERMINAL_IS_FINAL',
      };
    }
    const blocked = keys.filter((k) => !TERMINAL_WRITABLE.has(k) && k !== 'status');
    if (blocked.length > 0) {
      return {
        message: `A completed or closed Ticket is read-only; refused changes to ${blocked.join(', ')}. Reopen it first if it genuinely is not finished.`,
        code: 'TERMINAL_IS_READ_ONLY',
      };
    }
  }

  // ── PD-590: a live run is never silently detached ─────────────────────────
  // The loop's PR watcher selects `status = 'queue' AND agent_state = 'in-review'` (pr-state.ts),
  // and a dispatched run is tracked the same way. Moving the ticket out of the Queue mid-flight
  // therefore orphans it: the run keeps going (D-046 — an in-flight Robot is never interrupted),
  // finishes, opens a PR, and nothing is watching to complete the ticket when it merges. PD-464
  // reached exactly this state, with an open PR nobody was tracking.
  //
  // PD-536 already refuses to strand in-flight members during an Epic rollback. This is the same
  // rule for the gesture that had no guard at all: a single ticket dragged out of the Queue.
  if (existing.status === 'queue' && 'status' in patch && patch.status !== 'queue') {
    const state: string | null | undefined = existing.agentState;
    if (state === 'working' || state === 'in-review') {
      return {
        message:
          state === 'working'
            ? 'A Robot is working on this ticket right now. Moving it out of the Queue would leave the run with nothing tracking it — the run cannot be interrupted (D-046), so wait for it to hand off a PR.'
            : 'This ticket has a Robot PR awaiting review. Moving it out of the Queue would stop anything watching that PR, so nothing would complete the ticket when it merges — review or close the PR first.',
        code: 'RUN_IN_FLIGHT',
      };
    }
  }

  // ── D-080 / PD-509: a Ticket never leaves its Epic ─────────────────
  // Only *un-parenting* is refused, not "has no Epic". Moving between Epics stays free, and a
  // legacy Ticket that never had one is left editable — requiring an Epic on every edit would
  // enforce the model retroactively against history, and would break Core outright, which has 23
  // active tickets and no Epics yet (tracked as C-89).
  const becomingEpic = patch.isEpic === true;
  if (!becomingEpic && !existing.isEpic && 'epicId' in patch && patch.epicId === null) {
    if (existing.epicId !== null && !isTerminal(existing.status)) {
      return {
        message:
          'A Ticket cannot be removed from its Epic — move it to another one instead. Priority and dispatch both come from the Epic, so an Epic-less active Ticket is unpriced and undispatchable.',
        code: 'EPIC_REQUIRED',
      };
    }
  }

  return null;
}

/**
 * Why this create must be refused, or null when it may proceed.
 *
 * An Epic is required for a new non-Epic Ticket, which is the create-time half of the same rule the
 * board applies (`epicRequired`). Terminal creates are exempt: importing or recording something
 * already finished is bookkeeping about the past, not new work that needs pricing.
 */
export function createGuardFailure(input: {
  isEpic?: boolean;
  epicId?: number | null;
  status?: TicketStatus;
}): GuardFailure | null {
  if (input.isEpic === true) return null; // Epics do not nest, so they never need a parent.
  if (input.status !== undefined && isTerminal(input.status)) return null;
  if (input.epicId === undefined || input.epicId === null) {
    return {
      message:
        'Every Ticket belongs to an Epic — supply `epicId`, or create the Epic first. Priority and dispatch both come from the Epic (D-080).',
      code: 'EPIC_REQUIRED',
    };
  }
  return null;
}

/**
 * The patch a Reopen applies (D-083).
 *
 * Reopen is not a plain status write, and this is where that stops being a client convention. It
 * returns the Ticket to `backlog`, and the caller must supply an Epic when it has none — reopening
 * into an Epic-less active state would recreate exactly the unpriced, undispatchable dead end the
 * rule exists to prevent. `agent_state` is cleared by `updateTicket`'s own leaving-terminal path.
 */
export function reopenGuardFailure(
  existing: Pick<AgentTicket, 'status' | 'isEpic' | 'epicId'>,
  epicId: number | null | undefined,
): GuardFailure | null {
  if (existing.isEpic) {
    return {
      message:
        "An Epic's lane is derived from its members, so there is nothing to reopen — reopen a member instead.",
      code: 'EPIC_NOT_REOPENABLE',
    };
  }
  if (!isTerminal(existing.status)) {
    return { message: 'This Ticket is not completed or closed.', code: 'NOT_TERMINAL' };
  }
  if ((epicId ?? existing.epicId) === null) {
    return {
      message:
        'Reopening needs an Epic: supply `epicId`. An Epic-less active Ticket is unpriced and undispatchable (D-080).',
      code: 'EPIC_REQUIRED',
    };
  }
  return null;
}

// ── D-091 (PD-632): the Queue gate ───────────────────────────────────────────

/** What the gate needs to read, injected so this module stays free of the DB (the store builds it). */
export interface QueueGateContext {
  getTicket(id: number): AgentTicket | null;
  /** An Epic's live (non-archived) members. */
  listEpicMembers(epicId: number): AgentTicket[];
  /** Ids of the ticket's unresolved `blocks` blockers (D-048). */
  openBlockerIds(ticketId: number): number[];
}

export interface QueueGuardFailure extends GuardFailure {
  code: 'QUEUE_GATE';
  /** The full ordered criteria list, met and unmet, so the client renders rather than re-derives. */
  blockers: QueueCriterion[];
}

/** The patchable fields that decide whether a write puts a ticket into the robot's Queue. */
type QueuePatch = Partial<Pick<AgentTicket, 'status' | 'assignee' | 'refined' | 'readyBypassed' | 'epicId'>> & {
  body?: string | null;
};

function refusal(criteria: QueueCriterion[], subject: string): QueueGuardFailure | null {
  const unmet = queueEntryRefusals(criteria);
  if (unmet.length === 0) return null;
  return {
    message: `${subject} cannot enter the Queue for the Robot until it is refined (D-091): ${unmet
      .map((c) => c.label)
      .join('; ')}.`,
    code: 'QUEUE_GATE',
    blockers: criteria,
  };
}

/**
 * Why this write may not put robot work into the Queue, or null when it may proceed (D-091).
 *
 * **A state invariant, enforced on every edge into the state.** The guarded state is
 * `status = 'queue' ∧ assignee = 'robot'`; it is checked when a write *enters* it — moving a robot
 * ticket into the Queue, assigning a queued ticket to `robot`, or moving a queued robot ticket into
 * another Epic. A write that keeps a ticket in the state without changing what gates it (a title
 * edit, a drag) is not re-judged, and un-refining a queued ticket is allowed: the loop's selection
 * query is the backstop for that case, and warns about it.
 *
 * **An Epic entering the Queue is judged by its members.** Queueing an Epic cascades every `backlog`
 * member into the Queue (D-080), so it is refused when that would arm a robot member under an
 * unmet Epic-level criterion. An Epic with no robot members to arm is not gated at all.
 *
 * **`assignee = 'steve'` is never gated.** The harness claim (`{assignee:'steve', status:'queue'}`)
 * depends on that, and so does a human's own work: nothing dispatches it.
 */
export function queueGuardFailure(
  existing: AgentTicket,
  patch: QueuePatch,
  ctx: QueueGateContext,
): QueueGuardFailure | null {
  if (existing.isEpic) {
    const entering = patch.status === 'queue' && existing.status !== 'queue';
    if (!entering) return null;
    const members = ctx.listEpicMembers(existing.id);
    const armsRobot = members.some((m) => m.status === 'backlog' && m.assignee === 'robot');
    if (!armsRobot) return null;
    const refined = patch.refined ?? existing.refined;
    // A plain update that sets `refined` also clears the staleness (`updateTicket`, PD-610).
    const epicAfter = { id: existing.id, refined, refineStale: refined && !existing.refined ? false : existing.refineStale };
    return refusal(epicQueueCriteria(epicAfter, members), 'This Epic has robot members, and it');
  }

  const after = {
    status: patch.status ?? existing.status,
    assignee: patch.assignee === undefined ? existing.assignee : patch.assignee,
    epicId: patch.epicId === undefined ? existing.epicId : patch.epicId,
  };
  if (after.status !== 'queue' || after.assignee !== 'robot') return null;
  const wasInState = existing.status === 'queue' && existing.assignee === 'robot';
  if (wasInState && after.epicId === existing.epicId) return null;

  const ticket = {
    id: existing.id,
    refined: patch.refined ?? existing.refined,
    ready: patch.body === undefined ? existing.ready : isReady(patch.body),
    readyBypassed: patch.readyBypassed ?? existing.readyBypassed,
  };
  const epic = after.epicId === null ? null : ctx.getTicket(after.epicId);
  const criteria = queueBlockers({
    ticket,
    epic,
    members: epic ? ctx.listEpicMembers(epic.id) : [],
    openBlockerIds: ctx.openBlockerIds(existing.id),
  });
  return refusal(criteria, 'This ticket is assigned to the Robot, and it');
}
