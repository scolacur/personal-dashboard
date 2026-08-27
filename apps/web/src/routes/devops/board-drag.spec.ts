import { describe, it, expect } from 'vitest';
import type { AgentTicket } from '@dashboard/shared';
import { moveIsNoop, needsQueueBypass, pickBeforeId, rankOf, type DropCandidate } from './board-drag';

/** Cards at 100px intervals: midpoints 50, 150, 250, … in visual order. */
function lane(priorities: string[]): DropCandidate[] {
  return priorities.map((priority, i) => ({ id: i + 1, priority, midpointY: i * 100 + 50 }));
}

describe('rankOf', () => {
  it('ranks P0 first and unset last', () => {
    expect(rankOf('P0')).toBeLessThan(rankOf('P3'));
    expect(rankOf(null)).toBeGreaterThan(rankOf('P5'));
  });
});

describe('pickBeforeId', () => {
  it('inserts before the first same-priority card the cursor is above', () => {
    const cards = lane(['P1', 'P1', 'P1']);
    expect(pickBeforeId(cards, 'P1', 10)).toBe(1);
    expect(pickBeforeId(cards, 'P1', 120)).toBe(2);
  });

  it('appends when the cursor is past every card', () => {
    expect(pickBeforeId(lane(['P1', 'P1']), 'P1', 9999)).toBeNull();
  });

  // Rule 1: the lane is banded by priority, so a card of another band is never an insertion point.
  it('ignores cards of a different priority', () => {
    const cards = lane(['P0', 'P0', 'P1']);
    // Cursor above everything, but the P1 band starts at the third card.
    expect(pickBeforeId(cards, 'P1', 10)).toBe(3);
  });

  // Rule 2: the one that is easy to get wrong. Falling past your own band means the END OF THE
  // BAND — the first card of the next, lower band — not the end of the lane. Otherwise a P1 dropped
  // low would be appended after the P3s and snap back on the next read, looking like a no-op.
  it('lands at the end of its own band, not the end of the lane', () => {
    const cards = lane(['P1', 'P1', 'P3', 'P3']);
    expect(pickBeforeId(cards, 'P1', 9999)).toBe(3); // before the first P3
  });

  it('appends only when its band is the last one', () => {
    const cards = lane(['P1', 'P3', 'P3']);
    expect(pickBeforeId(cards, 'P3', 9999)).toBeNull();
  });

  it('treats unset priority as its own band, below everything', () => {
    const cards = lane(['P1', 'none', 'none']);
    expect(pickBeforeId(cards, null, 10)).toBe(2);
    expect(pickBeforeId(cards, 'P1', 9999)).toBe(2); // end of the P1 band = before the first unset
  });

  it('handles an empty lane', () => {
    expect(pickBeforeId([], 'P1', 0)).toBeNull();
  });
});

describe('moveIsNoop', () => {
  const t = { status: 'backlog', sortOrder: 10 } as Pick<AgentTicket, 'status' | 'sortOrder'>;

  it('is a no-op only when both lane and order are unchanged', () => {
    expect(moveIsNoop(t, 'backlog', 10)).toBe(true);
    expect(moveIsNoop(t, 'backlog', 11)).toBe(false);
    expect(moveIsNoop(t, 'queue', 10)).toBe(false);
  });
});

describe('needsQueueBypass', () => {
  const base = { status: 'backlog', assignee: 'robot', ready: false, readyBypassed: false } as Pick<
    AgentTicket,
    'status' | 'assignee' | 'ready' | 'readyBypassed'
  >;

  it('asks when an unready robot ticket enters the queue', () => {
    expect(needsQueueBypass(base, 'queue')).toBe(true);
  });

  it('does not ask for a lane that is not the queue', () => {
    expect(needsQueueBypass(base, 'backlog')).toBe(false);
  });

  it('does not ask again for a ticket already in the queue', () => {
    expect(needsQueueBypass({ ...base, status: 'queue' }, 'queue')).toBe(false);
  });

  it('does not ask when the body is Ready, or the bypass is already recorded', () => {
    expect(needsQueueBypass({ ...base, ready: true }, 'queue')).toBe(false);
    expect(needsQueueBypass({ ...base, readyBypassed: true }, 'queue')).toBe(false);
  });

  // Assignee is the dispatch axis: only the Robot's work is gated on being Ready-shaped.
  it('does not ask for Steve’s own work', () => {
    expect(needsQueueBypass({ ...base, assignee: 'steve' }, 'queue')).toBe(false);
    expect(needsQueueBypass({ ...base, assignee: null }, 'queue')).toBe(false);
  });
});
