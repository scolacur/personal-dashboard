import { describe, it, expect } from 'vitest';
import type { TicketRelation, TicketStatus } from '@dashboard/shared';
import { computeBadges, isResolvedStatus, relationLabel, RELATION_ACTIONS } from './relation-logic';

function rel(overrides: Partial<TicketRelation>): TicketRelation {
  return {
    id: 1,
    fromTicketId: 1,
    toTicketId: 2,
    type: 'blocks',
    origin: 'agent',
    createdAt: 0,
    ...overrides,
  };
}

describe('isResolvedStatus (D-051 "done or gone")', () => {
  it('treats completed/closed and unknown (archived → absent) as resolved', () => {
    expect(isResolvedStatus('completed')).toBe(true);
    expect(isResolvedStatus('closed')).toBe(true);
    expect(isResolvedStatus(undefined)).toBe(true);
  });
  it('treats the three active lanes as unresolved', () => {
    for (const s of ['backlog', 'prioritized', 'queue'] as TicketStatus[]) {
      expect(isResolvedStatus(s)).toBe(false);
    }
  });
});

describe('computeBadges', () => {
  it('counts only unresolved blockers as blocked-by, unresolved targets as blocking', () => {
    // 3 is the ticket. 1 blocks 3 (active), 2 blocks 3 (completed → resolved), 3 blocks 4 (active).
    const status = new Map<number, TicketStatus>([
      [1, 'backlog'],
      [2, 'completed'],
      [3, 'backlog'],
      [4, 'prioritized'],
    ]);
    const relations = [
      rel({ id: 10, fromTicketId: 1, toTicketId: 3, type: 'blocks' }),
      rel({ id: 11, fromTicketId: 2, toTicketId: 3, type: 'blocks' }),
      rel({ id: 12, fromTicketId: 3, toTicketId: 4, type: 'blocks' }),
    ];
    const b = computeBadges(3, relations, status);
    expect(b.blockedBy).toBe(1); // only ticket 1 (2 is completed)
    expect(b.blocking).toBe(1); // ticket 4
    expect(b.split).toBe(false);
  });

  it('flags split and lets a human split win the origin label over an auto-split', () => {
    const status = new Map<number, TicketStatus>([[1, 'backlog'], [2, 'backlog'], [3, 'backlog']]);
    const relations = [
      rel({ id: 20, fromTicketId: 1, toTicketId: 2, type: 'split', origin: 'agent' }),
      rel({ id: 21, fromTicketId: 1, toTicketId: 3, type: 'split', origin: 'human' }),
    ];
    const b = computeBadges(1, relations, status);
    expect(b.split).toBe(true);
    expect(b.splitOrigin).toBe('human');
  });

  it('ignores relations that do not touch the ticket', () => {
    const status = new Map<number, TicketStatus>([[9, 'backlog'], [8, 'backlog']]);
    const b = computeBadges(1, [rel({ fromTicketId: 9, toTicketId: 8 })], status);
    expect(b).toEqual({ blockedBy: 0, blocking: 0, split: false, splitOrigin: null });
  });
});

describe('RELATION_ACTIONS direction (D-051: from=blocker, to=blocked)', () => {
  const byKey = Object.fromEntries(RELATION_ACTIONS.map((a) => [a.key, a]));
  it('"Blocked by" makes the picked ticket the blocker (from)', () => {
    expect(byKey['blocked-by'].build(3, 7)).toEqual({ fromId: 7, toId: 3 });
  });
  it('"Blocking" makes the source the blocker (from)', () => {
    expect(byKey['blocking'].build(3, 7)).toEqual({ fromId: 3, toId: 7 });
  });
  it('"Split into" makes the source the parent (from)', () => {
    expect(byKey['split'].build(3, 7)).toEqual({ fromId: 3, toId: 7 });
  });
});

describe('relationLabel', () => {
  it('labels a blocks relation by direction from the ticket perspective', () => {
    expect(relationLabel({ id: 1, type: 'blocks', origin: 'human', direction: 'to', other: { ticketId: 2, displayId: 'PD-2', title: 't', status: 'backlog' }, createdAt: 0 })).toBe('Blocked by');
    expect(relationLabel({ id: 1, type: 'blocks', origin: 'human', direction: 'from', other: { ticketId: 2, displayId: 'PD-2', title: 't', status: 'backlog' }, createdAt: 0 })).toBe('Blocking');
  });
  it('marks an agent split as auto-split and a human split plainly', () => {
    expect(relationLabel({ id: 1, type: 'split', origin: 'agent', direction: 'from', other: { ticketId: 2, displayId: 'PD-2', title: 't', status: 'backlog' }, createdAt: 0 })).toBe('Auto-split into 🤖');
    expect(relationLabel({ id: 1, type: 'split', origin: 'human', direction: 'from', other: { ticketId: 2, displayId: 'PD-2', title: 't', status: 'backlog' }, createdAt: 0 })).toBe('Split into');
  });
});
