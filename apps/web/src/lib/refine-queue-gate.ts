import {
  epicQueueCriteria,
  queueEntryRefusals,
  type AgentTicket,
  type QueueCriterion,
} from '@dashboard/shared';

/**
 * "Approve & queue" on a Refine thread, read against the Queue gate (PD-760, D-091).
 *
 * Approving writes the proposal and marks the ticket refined, so the ticket's own `refined` row is
 * met by the approval itself; what can still refuse is its Epic. This module predicts that refusal
 * from what the page already knows, and turns either the prediction or the server's 409 `blockers`
 * into rows with a remedy each. The server stays the authority (D-091 §2): a prediction only saves
 * a round trip, and a 409 the page did not foresee is rendered from the server's own criteria.
 *
 * Kept out of the component because `apps/web` has no component-rendering tests.
 */

export type EpicLike = Pick<AgentTicket, 'id' | 'displayId' | 'title' | 'refined' | 'refineStale'>;
export type MemberLike = Pick<AgentTicket, 'id' | 'displayId' | 'title' | 'refined' | 'status'>;

/** The refusals the page can foresee for approving `ticketId` into the Queue. Empty = none foreseen. */
export function predictQueueRefusals(
  ticketId: number,
  epic: EpicLike | null,
  members: readonly MemberLike[],
): QueueCriterion[] {
  if (!epic) return [];
  return queueEntryRefusals(epicQueueCriteria(epic, members, ticketId));
}

export type RefusalAction =
  | { kind: 'mark-epic-refined'; epicId: number; text: string }
  | { kind: 'link'; href: string; text: string };

export interface RefusalRow {
  id: QueueCriterion['id'];
  label: string;
  action: RefusalAction | null;
}

const name = (t: { displayId: string | null; title: string }) => (t.displayId ? `${t.displayId} (${t.title})` : t.title);
const href = (t: { displayId: string | null } | null) => (t?.displayId ? `/devops/tickets/${t.displayId}` : null);

/**
 * One row per criterion that refuses entry, labelled with the Epic's id and title where it has one,
 * each with the control that satisfies it. Met and non-refusing criteria are dropped: this panel
 * answers "why not", not the whole checklist the board's modal shows.
 */
export function refusalRows(
  criteria: readonly QueueCriterion[],
  epic: EpicLike | null,
  members: readonly MemberLike[] = [],
  ticketId?: number,
): RefusalRow[] {
  const epicHref = href(epic);
  return queueEntryRefusals(criteria).map((c): RefusalRow => {
    if (c.id === 'epic-refined' && epic) {
      return {
        id: c.id,
        label: `Epic ${name(epic)} is not refined`,
        action: { kind: 'mark-epic-refined', epicId: epic.id, text: `Mark ${epic.displayId ?? 'the Epic'} refined` },
      };
    }
    if (c.id === 'epic-not-stale' && epic) {
      return {
        id: c.id,
        label: `Epic ${name(epic)} changed since it was refined and needs re-refining`,
        action: epicHref ? { kind: 'link', href: epicHref, text: `Open ${epic.displayId}` } : null,
      };
    }
    if (c.id === 'members-refined' && epic) {
      const first = members.find(
        (m) => m.id !== ticketId && !m.refined && m.status !== 'completed' && m.status !== 'closed',
      );
      const firstHref = href(first ?? null);
      return {
        id: c.id,
        label: c.label.replace('its Epic', name(epic)),
        action: firstHref && first
          ? { kind: 'link', href: firstHref, text: `Open ${first.displayId}` }
          : epicHref
            ? { kind: 'link', href: epicHref, text: `Open ${epic.displayId}` }
            : null,
      };
    }
    return { id: c.id, label: c.label, action: null };
  });
}

/** The short hint beside the button when a refusal is foreseen, e.g. "Epic PD-530 not refined". */
export function refusalHint(refusals: readonly QueueCriterion[], epic: EpicLike | null): string | null {
  if (refusals.length === 0) return null;
  const e = epic?.displayId ? `Epic ${epic.displayId}` : 'Epic';
  switch (refusals[0].id) {
    case 'epic-refined':
      return `${e} not refined`;
    case 'epic-not-stale':
      return `${e} needs re-refining`;
    case 'members-refined':
      return `${e} has unrefined members`;
    default:
      return 'Queue gate will refuse';
  }
}
