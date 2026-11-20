import type { AgentNotification } from '@dashboard/shared';
import { REFINE_QUESTIONS_NOTIFICATION_PREFIX } from '@dashboard/shared';

/** The Decisions inbox route (PD-746). */
export const DECISIONS_ROUTE = '/devops/decisions';

/** The anchor of one ticket's visual check in the Decisions inbox (PD-773). */
export function visualAnchor(displayId: string): string {
  return `v-${displayId}`;
}

/** The anchor of one ticket's entry in the Decisions inbox. */
export function decisionsAnchor(displayId: string): string {
  return `t-${displayId}`;
}

/**
 * Where a notification takes you. A Refine notification raised for a structured question round
 * opens that ticket's entry in the Decisions inbox, where it can be answered inline (PD-746); every
 * other ticket notification opens the ticket page, as before.
 */
export function notificationHref(n: Pick<AgentNotification, 'kind' | 'title' | 'ticketDisplayId'>): string | null {
  if (!n.ticketDisplayId) return null;
  if (n.kind === 'agent_visual_review') return `${DECISIONS_ROUTE}#${visualAnchor(n.ticketDisplayId)}`;
  if (n.kind === 'agent_refine' && n.title.startsWith(REFINE_QUESTIONS_NOTIFICATION_PREFIX)) {
    return `${DECISIONS_ROUTE}#${decisionsAnchor(n.ticketDisplayId)}`;
  }
  return `/devops/tickets/${n.ticketDisplayId}`;
}
