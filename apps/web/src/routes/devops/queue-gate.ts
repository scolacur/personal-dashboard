import {
  epicQueueCriteria,
  isReady,
  queueBlockers,
  queueEntryRefusals,
  type AgentTicket,
  type QueueCriterion,
  type TicketAssignee,
  type TicketRelation,
  type TicketStatus,
} from '@dashboard/shared';
import { isResolvedStatus } from './relation-logic';

/**
 * The board's read of the Queue gate (D-091, PD-633).
 *
 * Every door into `queue ∧ assignee = 'robot'` asks this module first, then routes the answer
 * through one modal (`QueueGateModal`). The criteria come from `queueBlockers()` /
 * `epicQueueCriteria()` in `packages/shared`, the same predicate the server's guard runs, so the
 * board predicts the server's answer instead of re-deriving it. If the two disagree anyway (stale
 * board data), the server's 409 carries its own criteria and `gateFromServer` renders those.
 *
 * Kept out of the component because `apps/web` has no component-rendering tests, so logic left in
 * a `.svelte` file has no test coverage at all.
 */

/** A ticket or Epic, reduced to what the modal names and links to. */
export interface GateRef {
  id: number;
  displayId: string | null;
  title: string;
}

const ref = (t: Pick<AgentTicket, 'id' | 'displayId' | 'title'>): GateRef => ({
  id: t.id,
  displayId: t.displayId,
  title: t.title,
});

/** Ids of the open tickets that `blocks` this one. The same rule the badges use. */
export function openBlockerIds(ticketId: number, relations: readonly TicketRelation[], tickets: readonly AgentTicket[]): number[] {
  const statusById = new Map(tickets.map((t) => [t.id, t.status]));
  return relations
    .filter((r) => r.type === 'blocks' && r.toTicketId === ticketId && !isResolvedStatus(statusById.get(r.fromTicketId)))
    .map((r) => r.fromTicketId);
}

const isOpen = (m: Pick<AgentTicket, 'status'>) => m.status !== 'completed' && m.status !== 'closed';

/** The fields of a ticket write that decide whether it enters the gated state. */
export interface TicketWrite {
  status?: TicketStatus;
  assignee?: TicketAssignee | null;
  epicId?: number | null;
  body?: string | null;
  refined?: boolean;
  readyBypassed?: boolean;
}

/**
 * Whether a write puts a ticket into `queue ∧ robot`, mirroring the server guard: entering the
 * state, or being re-parented while in it. A write that keeps a ticket in the state without
 * changing what gates it is not re-judged. `existing` is null for a ticket being created.
 */
export function entersRobotQueue(
  existing: Pick<AgentTicket, 'status' | 'assignee' | 'epicId'> | null,
  write: TicketWrite,
): boolean {
  const status = write.status ?? existing?.status ?? 'backlog';
  const assignee = write.assignee === undefined ? (existing?.assignee ?? null) : write.assignee;
  if (status !== 'queue' || assignee !== 'robot') return false;
  if (existing === null) return true;
  const epicId = write.epicId === undefined ? existing.epicId : write.epicId;
  const wasInState = existing.status === 'queue' && existing.assignee === 'robot';
  return !wasInState || epicId !== existing.epicId;
}

/** One gate answer for one ticket. */
export interface TicketGate {
  kind: 'ticket';
  /** Null for a ticket that does not exist yet (the create form). */
  ticket: GateRef | null;
  label: string;
  epic: GateRef | null;
  criteria: QueueCriterion[];
  /** The unmet criteria that refuse entry. Empty means Confirm is allowed. */
  refused: QueueCriterion[];
  /** Open members of the Epic that are not refined (`members-refined`'s detail). */
  unrefinedMembers: GateRef[];
  /** Open tickets blocking this one (`unblocked`'s detail). */
  blockers: GateRef[];
}

/** What a door should do with a gate answer. */
export type GateOutcome = 'proceed' | 'bypass' | 'refuse';

export function gateOutcome(gate: TicketGate | EpicGate): GateOutcome {
  if (gate.refused.length > 0) return 'refuse';
  if (gate.kind === 'ticket' && needsReadyBypass(gate)) return 'bypass';
  return 'proceed';
}

/** `ready` unmet and not yet bypassed: queueable, but only past D-058's acknowledgement. */
export function needsReadyBypass(gate: TicketGate): boolean {
  return gate.criteria.some((c) => c.id === 'ready' && !c.met);
}

/**
 * The gate answer for a ticket write, or null when the write does not enter the gated state.
 * The ticket is judged as it WOULD be after the write, exactly as the server judges it.
 */
export function planTicketGate(input: {
  existing: AgentTicket | null;
  write: TicketWrite;
  /** For a ticket being created: its title, since there is no row to name it from. */
  draftTitle?: string;
  tickets: readonly AgentTicket[];
  relations: readonly TicketRelation[];
}): TicketGate | null {
  const { existing, write, tickets, relations } = input;
  if (!entersRobotQueue(existing, write)) return null;

  const epicId = write.epicId === undefined ? (existing?.epicId ?? null) : write.epicId;
  const epic = epicId === null ? null : (tickets.find((t) => t.id === epicId) ?? null);
  const members = epic ? tickets.filter((t) => t.epicId === epic.id) : [];
  // A ticket being created has no id. -1 matches nothing, so it is not excluded from its own
  // Epic's member list either, which is right: it is not a member yet.
  const id = existing?.id ?? -1;
  const blockerIds = existing ? openBlockerIds(existing.id, relations, tickets) : [];

  const criteria = queueBlockers({
    ticket: {
      id,
      // A new ticket is always born unrefined (CreateTicketInput carries no `refined`).
      refined: write.refined ?? existing?.refined ?? false,
      ready: write.body === undefined ? (existing?.ready ?? false) : isReady(write.body),
      readyBypassed: write.readyBypassed ?? existing?.readyBypassed ?? false,
    },
    epic,
    members,
    openBlockerIds: blockerIds,
  });

  const byId = new Map(tickets.map((t) => [t.id, t]));
  return {
    kind: 'ticket',
    ticket: existing ? ref(existing) : null,
    label: existing ? (existing.displayId ?? existing.title) : (input.draftTitle ?? 'This ticket'),
    epic: epic ? ref(epic) : null,
    criteria,
    refused: queueEntryRefusals(criteria),
    unrefinedMembers: members.filter((m) => m.id !== id && isOpen(m) && !m.refined).map(ref),
    blockers: blockerIds.flatMap((b) => {
      const t = byId.get(b);
      return t ? [ref(t)] : [];
    }),
  };
}

/** A member the Epic gate names, with the criteria it fails on its own account. */
export interface EpicGateMember {
  member: GateRef;
  /** Its own unmet criteria: `refined`, and for an armed Robot member also `ready` / `unblocked`. */
  unmet: QueueCriterion[];
}

/** One gate answer for an Epic being queued: per-Epic, never per-member (PD-633). */
export interface EpicGate {
  kind: 'epic';
  epic: GateRef;
  label: string;
  /** The Epic-level criteria, the only ones the server refuses an Epic on. */
  criteria: QueueCriterion[];
  refused: QueueCriterion[];
  /** Robot members the cascade would arm (unstarted, in Backlog). */
  armed: number;
  /** Of those, how many meet every criterion of their own. */
  clear: number;
  /** Every open member with something unmet, in board order. */
  members: EpicGateMember[];
}

/**
 * The gate answer for queueing an Epic, or null when the server would not gate it, which is when
 * the cascade would arm no Robot member (D-091 §4).
 */
export function planEpicGate(
  epic: AgentTicket,
  tickets: readonly AgentTicket[],
  relations: readonly TicketRelation[],
): EpicGate | null {
  if (epic.status === 'queue') return null;
  const members = tickets.filter((t) => t.epicId === epic.id);
  const armedRobot = members.filter((m) => m.status === 'backlog' && m.assignee === 'robot');
  if (armedRobot.length === 0) return null;

  const criteria = epicQueueCriteria(epic, members);
  const rows: EpicGateMember[] = [];
  let clear = 0;
  for (const m of members) {
    if (!isOpen(m)) continue;
    const armed = m.status === 'backlog' && m.assignee === 'robot';
    const own = queueBlockers({
      ticket: m,
      epic: null,
      members: [],
      openBlockerIds: armed ? openBlockerIds(m.id, relations, tickets) : [],
    }).filter((c) => !c.met && (c.id === 'refined' || (armed && (c.id === 'ready' || c.id === 'unblocked'))));
    if (armed && own.length === 0) clear++;
    if (own.length > 0) rows.push({ member: ref(m), unmet: own });
  }

  return {
    kind: 'epic',
    epic: ref(epic),
    label: epic.displayId ?? epic.title,
    criteria,
    refused: queueEntryRefusals(criteria),
    armed: armedRobot.length,
    clear,
    members: rows,
  };
}

/** "9 of 13 Robot members are clear to run". The Epic modal's headline count. */
export function epicAggregate(gate: EpicGate): string {
  return `${gate.clear} of ${gate.armed} Robot member${gate.armed === 1 ? '' : 's'} ${gate.armed === 1 ? 'is' : 'are'} clear to run`;
}

/**
 * A gate answer built from the server's 409 `blockers`, for when the board's prediction missed
 * (its data was stale). The criteria are the server's; the detail lists are what the board knows.
 */
export function gateFromServer(
  criteria: QueueCriterion[],
  subject: AgentTicket,
  tickets: readonly AgentTicket[],
  relations: readonly TicketRelation[],
): TicketGate | EpicGate {
  if (subject.isEpic) {
    const plan = planEpicGate({ ...subject, status: 'backlog' }, tickets, relations);
    return {
      kind: 'epic',
      epic: ref(subject),
      label: subject.displayId ?? subject.title,
      criteria,
      refused: queueEntryRefusals(criteria),
      armed: plan?.armed ?? 0,
      clear: plan?.clear ?? 0,
      members: plan?.members ?? [],
    };
  }
  const epic = subject.epicId === null ? null : (tickets.find((t) => t.id === subject.epicId) ?? null);
  const byId = new Map(tickets.map((t) => [t.id, t]));
  return {
    kind: 'ticket',
    ticket: ref(subject),
    label: subject.displayId ?? subject.title,
    epic: epic ? ref(epic) : null,
    criteria,
    refused: queueEntryRefusals(criteria),
    unrefinedMembers: epic
      ? tickets.filter((m) => m.epicId === epic.id && m.id !== subject.id && isOpen(m) && !m.refined).map(ref)
      : [],
    blockers: openBlockerIds(subject.id, relations, tickets).flatMap((b) => {
      const t = byId.get(b);
      return t ? [ref(t)] : [];
    }),
  };
}

/** The detail-page link for a ticket, or null when it has no display id to route by. */
export function ticketHref(r: GateRef | null): string | null {
  return r?.displayId ? `/devops/tickets/${r.displayId}` : null;
}
