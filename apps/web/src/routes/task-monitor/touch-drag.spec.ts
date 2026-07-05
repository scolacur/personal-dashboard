import { describe, it, expect } from 'vitest';
import { insertionBeforeId } from './touch-drag';

const PR: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4, P5: 5, none: 6 };

function card(id: number, priority: string, top: number, height = 60) {
  return { id, priority, top, height };
}

describe('insertionBeforeId', () => {
  it('returns null for an empty column (append to end)', () => {
    expect(insertionBeforeId(100, 3, [], PR)).toBe(null);
  });

  it('returns first card id when cursor is above its midpoint', () => {
    // card midpoint = 100 + 30 = 130; cursor 129 < 130 → insert before card 1
    const cards = [card(1, 'P3', 100)];
    expect(insertionBeforeId(129, 3, cards, PR)).toBe(1);
  });

  it('returns null when cursor is below the only same-priority card (append)', () => {
    // midpoint = 130; cursor 131 > 130 → no match, no lower band → null
    const cards = [card(1, 'P3', 100)];
    expect(insertionBeforeId(131, 3, cards, PR)).toBe(null);
  });

  it('inserts between two cards in the same priority band', () => {
    // card 1: midpoint = 30; card 2: midpoint = 100
    // cursor 50: past card1 midpoint, before card2 midpoint → insert before card 2
    const cards = [card(1, 'P3', 0), card(2, 'P3', 70)];
    expect(insertionBeforeId(50, 3, cards, PR)).toBe(2);
  });

  it('appends to end of band when cursor is past last same-priority card (returns first lower-band card)', () => {
    // P3 cards exhausted; next band is 'none'; return its id
    const cards = [card(1, 'P3', 0), card(2, 'P3', 70), card(3, 'none', 140)];
    expect(insertionBeforeId(200, 3, cards, PR)).toBe(3);
  });

  it('returns null when past the last card and no lower-priority band exists', () => {
    const cards = [card(1, 'P3', 0)];
    expect(insertionBeforeId(200, 3, cards, PR)).toBe(null);
  });

  it('ignores cards from other priority bands when computing insertion within the band', () => {
    // P1 card at top, then two P3 cards
    const cards = [card(1, 'P1', 0), card(2, 'P3', 70), card(3, 'P3', 140)];
    // cursor 80, rank P3: skip P1 card; card 2 midpoint=100 > 80 → insert before card 2
    expect(insertionBeforeId(80, 3, cards, PR)).toBe(2);
  });

  it('correctly appends to end when cursor is between two different-band cards', () => {
    // P2 card at 0, P5 card at 70 — dragging a P2 card past the only P2 card
    const cards = [card(1, 'P2', 0), card(2, 'P5', 70)];
    // cursor 200, rank P2: past P2 midpoint (30); next band is P5 → return card 2
    expect(insertionBeforeId(200, 2, cards, PR)).toBe(2);
  });

  it('handles single-card column where cursor is above that card', () => {
    const cards = [card(42, 'none', 200)];
    expect(insertionBeforeId(150, 6, cards, PR)).toBe(42);
  });
});
