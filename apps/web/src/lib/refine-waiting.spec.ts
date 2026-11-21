import { describe, expect, it } from 'vitest';
import type { TicketEvent } from '@dashboard/shared';
import { refineWaitingOnHuman } from './refine-waiting';

let nextId = 1;
const ev = (type: string, t: number): TicketEvent =>
  ({ id: nextId++, ticketId: 1, type, detail: { text: 'x' }, createdAt: t }) as unknown as TicketEvent;

describe('refineWaitingOnHuman', () => {
  it('is false with no Refine conversation', () => {
    expect(refineWaitingOnHuman([ev('created', 1)])).toBe(false);
  });

  it('is true when the agent spoke last in an open session', () => {
    expect(refineWaitingOnHuman([ev('refine_human', 1), ev('refine_agent', 2)])).toBe(true);
  });

  it('is false while the agent is working on Steve’s turn', () => {
    expect(refineWaitingOnHuman([ev('refine_agent', 1), ev('refine_human', 2)])).toBe(false);
  });

  it('is false once the session has ended (committed or parked)', () => {
    expect(refineWaitingOnHuman([ev('refine_agent', 1), ev('refine_committed', 2)])).toBe(false);
    expect(refineWaitingOnHuman([ev('refine_agent', 1), ev('refine_parked', 2)])).toBe(false);
  });
});
