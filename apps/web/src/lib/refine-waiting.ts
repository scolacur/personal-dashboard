import type { TicketEvent } from '@dashboard/shared';
import { refineSessionEnd, refineThreadFromEvents } from '@dashboard/shared';

/**
 * Whether the Refine agent is waiting on Steve: the session is open and the newest turn is the
 * agent's. The same rule as a ticket's `refineState === 'awaiting-human'`, read from the event log
 * so a page can keep it live by re-polling events without reloading the ticket.
 *
 * Drives the notification dot on the detail page's Refine button (desktop) and Refine tab (mobile).
 */
export function refineWaitingOnHuman(events: readonly TicketEvent[]): boolean {
  if (refineSessionEnd(events) !== null) return false;
  const thread = refineThreadFromEvents([...events]);
  return thread.length > 0 && thread[thread.length - 1].role === 'agent';
}
