import { describe, it, expect } from 'vitest';
import { REFINE_QUESTIONS_NOTIFICATION_PREFIX } from '@dashboard/shared';
import { notificationHref } from './notification-links';

describe('notificationHref (PD-746)', () => {
  it('sends a structured-round Refine notification to the Decisions inbox, anchored at the ticket', () => {
    expect(
      notificationHref({ kind: 'agent_refine', title: `${REFINE_QUESTIONS_NOTIFICATION_PREFIX} 2 questions on PD-7`, ticketDisplayId: 'PD-7' }),
    ).toBe('/devops/decisions#t-PD-7');
  });

  it('keeps every other ticket notification on the ticket page, including other Refine ones', () => {
    expect(notificationHref({ kind: 'agent_refine', title: 'Refine agent replied on PD-7', ticketDisplayId: 'PD-7' })).toBe('/devops/tickets/PD-7');
    expect(notificationHref({ kind: 'agent_refine', title: 'Refine agent proposed changes on PD-7', ticketDisplayId: 'PD-7' })).toBe('/devops/tickets/PD-7');
    expect(notificationHref({ kind: 'agent_needs_human', title: 'x', ticketDisplayId: 'PD-7' })).toBe('/devops/tickets/PD-7');
  });

  it('has no link without a ticket', () => {
    expect(notificationHref({ kind: 'agent_refine', title: REFINE_QUESTIONS_NOTIFICATION_PREFIX, ticketDisplayId: null })).toBeNull();
  });
});
