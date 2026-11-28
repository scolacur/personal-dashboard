import type { AgentNotification } from '@dashboard/shared';
import { REFINE_QUESTIONS_NOTIFICATION_PREFIX } from '@dashboard/shared';

/** The Decisions inbox route (PD-746). */
export const DECISIONS_ROUTE = '/devops/decisions';

/** The Ticket Audit report route — where an `audit_complete` notification lands (PD-851). */
export const TICKET_AUDIT_REPORT_ROUTE = '/devops/reports/ticket-audit';

/** The anchor of one ticket's visual check in the Decisions inbox (PD-773). */
export function visualAnchor(displayId: string): string {
  return `v-${displayId}`;
}

/** The anchor of one ticket's entry in the Decisions inbox. */
export function decisionsAnchor(displayId: string): string {
  return `t-${displayId}`;
}

/** The anchor of a ticket suggestion in the Decisions inbox (PD-979, D-119). Keyed by the source
 *  ticket's display id — one PR, one suggestion, so this is unique in practice. */
export function suggestionAnchor(displayId: string): string {
  return `sug-${displayId}`;
}

/**
 * Where a notification takes you. A Refine notification raised for a structured question round
 * opens that ticket's entry in the Decisions inbox, where it can be answered inline (PD-746); every
 * other ticket notification opens the ticket page, as before — a Robot park with its actions open.
 */
export function notificationHref(n: Pick<AgentNotification, 'kind' | 'title' | 'ticketDisplayId'>): string | null {
  // PD-851: the audit-complete notification is ticketless — it links to the report regardless.
  if (n.kind === 'audit_complete') return TICKET_AUDIT_REPORT_ROUTE;
  if (!n.ticketDisplayId) return null;
  if (n.kind === 'agent_visual_review') return `${DECISIONS_ROUTE}#${visualAnchor(n.ticketDisplayId)}`;
  if (n.kind === 'agent_ticket_suggestion') return `${DECISIONS_ROUTE}#${suggestionAnchor(n.ticketDisplayId)}`;
  if (n.kind === 'agent_refine' && n.title.startsWith(REFINE_QUESTIONS_NOTIFICATION_PREFIX)) {
    return `${DECISIONS_ROUTE}#${decisionsAnchor(n.ticketDisplayId)}`;
  }
  // PD-965: a Robot park opens the page's "needs you" modal on arrival. The page only opens it while
  // the ticket is still in an input-needed state, so a stale notification just lands on the page.
  if (n.kind === 'agent_needs_human' || n.kind === 'agent_awaiting_human') {
    return `/devops/tickets/${n.ticketDisplayId}?needs-you`;
  }
  return `/devops/tickets/${n.ticketDisplayId}`;
}
