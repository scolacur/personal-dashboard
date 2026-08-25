import type { AgentTicket, TicketStatus } from '@dashboard/shared';

/**
 * The queue-model invariants, enforced at the HTTP boundary (PD-542).
 *
 * Two rules were previously enforced **only by the board**, so Refine, a stale client, or a `curl`
 * could still produce states the UI prevents:
 *
 *  - **D-TMP-PD539a** — a terminal Ticket is read-only, and leaving terminal happens only via an
 *    explicit Reopen.
 *  - **D-TMP-PD383a / PD-509** — a Ticket belongs to an Epic, and never leaves one.
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
 * is the thing D-TMP-PD539a exists to protect.
 */
const TERMINAL_WRITABLE = new Set(['githubIssueNumber', 'archivedAt']);

/**
 * Why this PATCH must be refused, or null when it may proceed.
 *
 * `patch` is the already-validated field set; `existing` is the ticket as stored.
 */
export function patchGuardFailure(
  existing: Pick<AgentTicket, 'status' | 'isEpic' | 'epicId'>,
  patch: Record<string, unknown>,
): GuardFailure | null {
  const keys = Object.keys(patch);

  // ── D-TMP-PD539a: terminal is final ───────────────────────────────────────
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

  // ── D-TMP-PD383a / PD-509: a Ticket never leaves its Epic ─────────────────
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
        'Every Ticket belongs to an Epic — supply `epicId`, or create the Epic first. Priority and dispatch both come from the Epic (D-TMP-PD383a).',
      code: 'EPIC_REQUIRED',
    };
  }
  return null;
}

/**
 * The patch a Reopen applies (D-TMP-PD539a).
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
        'Reopening needs an Epic: supply `epicId`. An Epic-less active Ticket is unpriced and undispatchable (D-TMP-PD383a).',
      code: 'EPIC_REQUIRED',
    };
  }
  return null;
}
