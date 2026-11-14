import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AcuteStrategyIdea } from '@dashboard/shared';
import {
  drawFromDeck,
  deckProgress,
  loadDeckMode,
  saveDeckMode,
  loadDeckSeen,
  saveDeckSeen,
} from './deck';

function makeIdea(id: number): AcuteStrategyIdea {
  return { id, text: `Idea ${id}`, type: 'Acute', tags: [], created_at: 0, updated_at: 0 };
}

const pool: AcuteStrategyIdea[] = [1, 2, 3, 4, 5].map(makeIdea);

/** Draw `count` cards, threading the seen set + last id forward like the UI does. */
function playDraws(
  startPool: AcuteStrategyIdea[],
  count: number,
  startSeen: number[] = [],
  startLast: number | null = null,
) {
  let seen = startSeen;
  let last = startLast;
  const drawn: number[] = [];
  const rounds: number[] = [];
  for (let k = 0; k < count; k++) {
    const r = drawFromDeck(startPool, seen, last);
    if (r.idea) {
      drawn.push(r.idea.id);
      last = r.idea.id;
      if (r.newRound) rounds.push(k);
    }
    seen = r.seenIds;
  }
  return { drawn, seen, last };
}

describe('drawFromDeck', () => {
  it('deals a full round with no repeats before any card recurs', () => {
    const { drawn, seen } = playDraws(pool, pool.length);
    expect(drawn).toHaveLength(pool.length);
    // Every id drawn exactly once.
    expect(new Set(drawn).size).toBe(pool.length);
    expect([...drawn].sort()).toEqual([1, 2, 3, 4, 5]);
    // The seen set now covers the whole pool.
    expect(new Set(seen)).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  it('rolls over into a new round with no back-to-back repeat (run many times)', () => {
    // Deterministic guarantee: the first draw of a new round excludes the last
    // card of the previous round. Repeat to exercise the randomness.
    for (let attempt = 0; attempt < 100; attempt++) {
      const round1 = playDraws(pool, pool.length);
      const r = drawFromDeck(pool, round1.seen, round1.last);
      expect(r.newRound).toBe(true);
      expect(r.idea).not.toBeNull();
      expect(r.idea!.id).not.toBe(round1.last);
      // The new round's seen set holds only the freshly drawn card.
      expect(r.seenIds).toEqual([r.idea!.id]);
    }
  });

  it('returns null and leaves the seen set unchanged for an empty pool', () => {
    const r = drawFromDeck([], [1, 2], 1);
    expect(r.idea).toBeNull();
    expect(r.newRound).toBe(false);
    expect(r.seenIds).toEqual([1, 2]);
  });

  it('repeats the only card when the pool has a single idea', () => {
    const single = [makeIdea(7)];
    const first = drawFromDeck(single, [], null);
    expect(first.idea!.id).toBe(7);
    // Next draw: pool exhausted, new round, single-card pool is allowed to repeat.
    const second = drawFromDeck(single, first.seenIds, 7);
    expect(second.newRound).toBe(true);
    expect(second.idea!.id).toBe(7);
  });

  it('does not mutate the input seen array', () => {
    const seen = [1];
    drawFromDeck(pool, seen, null);
    expect(seen).toEqual([1]);
  });

  describe('filter change mid-round', () => {
    it('keeps already-seen ideas seen and ends the round when the narrowed pool is exhausted', () => {
      // See two cards of the full pool.
      const twoSeen = playDraws(pool, 2);
      expect(twoSeen.seen).toHaveLength(2);

      // Narrow the pool to {1,2,3}. Any of those two already seen stay seen.
      const narrowed = [1, 2, 3].map(makeIdea);
      const seenInNarrowed = twoSeen.seen.filter((id) => id <= 3);
      const remaining = 3 - seenInNarrowed.length;

      // Draw exactly the remaining unseen cards of the narrowed pool.
      let seen = twoSeen.seen;
      let last = twoSeen.last;
      for (let k = 0; k < remaining; k++) {
        const r = drawFromDeck(narrowed, seen, last);
        expect(r.newRound).toBe(false);
        expect(seenInNarrowed).not.toContain(r.idea!.id);
        seen = r.seenIds;
        last = r.idea!.id;
      }

      // Narrowed pool now fully seen — the next draw opens a new round.
      const rollover = drawFromDeck(narrowed, seen, last);
      expect(rollover.newRound).toBe(true);
    });

    it('starts a new round immediately when a narrowed pool is already fully seen', () => {
      // Full round over the whole pool.
      const full = playDraws(pool, pool.length);
      const narrowed = [1, 2].map(makeIdea);
      // {1,2} are already seen, so drawing on the narrowed pool rolls over.
      const r = drawFromDeck(narrowed, full.seen, full.last);
      expect(r.newRound).toBe(true);
      expect([1, 2]).toContain(r.idea!.id);
    });
  });

  describe('idea deleted mid-round', () => {
    it('continues the round over the remaining ideas without resetting', () => {
      // See two cards, then delete one idea that has NOT been seen.
      const twoSeen = playDraws(pool, 2);
      const seenIds = twoSeen.seen;
      const deletable = pool.find((i) => !seenIds.includes(i.id))!;
      const remainingPool = pool.filter((i) => i.id !== deletable.id);

      // Round is not reset; drawing continues over the ideas still in the pool.
      const unseenRemaining = remainingPool.filter((i) => !seenIds.includes(i.id)).length;
      let seen = seenIds;
      let last = twoSeen.last;
      const drawn: number[] = [];
      for (let k = 0; k < unseenRemaining; k++) {
        const r = drawFromDeck(remainingPool, seen, last);
        expect(r.newRound).toBe(false);
        expect(r.idea!.id).not.toBe(deletable.id);
        drawn.push(r.idea!.id);
        seen = r.seenIds;
        last = r.idea!.id;
      }
      // No repeats among the continued draws.
      expect(new Set(drawn).size).toBe(drawn.length);
      // The whole remaining pool is now seen → next draw rolls over.
      expect(drawFromDeck(remainingPool, seen, last).newRound).toBe(true);
    });

    it('tolerates a stale seen id for an idea that no longer exists', () => {
      // id 99 was seen but is gone from the pool — progress ignores it and the
      // round still ends when the real pool is exhausted.
      const seen = [1, 2, 3, 4, 5, 99];
      const r = drawFromDeck(pool, seen, 5);
      expect(r.newRound).toBe(true);
    });
  });
});

describe('deckProgress', () => {
  it('counts seen ideas within the current pool', () => {
    expect(deckProgress(pool, [1, 2])).toEqual({ seen: 2, total: 5 });
  });

  it('ignores seen ids that are not in the pool', () => {
    expect(deckProgress(pool, [1, 2, 99])).toEqual({ seen: 2, total: 5 });
  });

  it('reflects a narrowed pool', () => {
    const narrowed = [1, 2, 3].map(makeIdea);
    expect(deckProgress(narrowed, [1, 2, 4, 5])).toEqual({ seen: 2, total: 3 });
  });

  it('is zero for an empty pool', () => {
    expect(deckProgress([], [1, 2])).toEqual({ seen: 0, total: 0 });
  });
});

describe('localStorage persistence', () => {
  let store: Record<string, string>;

  beforeEach(() => {
    store = {};
    // Minimal in-memory localStorage (vitest runs in node with no DOM).
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => {
        store[k] = String(v);
      },
      removeItem: (k: string) => {
        delete store[k];
      },
      clear: () => {
        store = {};
      },
      key: (i: number) => Object.keys(store)[i] ?? null,
      get length() {
        return Object.keys(store).length;
      },
    } as Storage;
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it('round-trips the deck-mode flag', () => {
    expect(loadDeckMode()).toBe(false);
    saveDeckMode(true);
    expect(loadDeckMode()).toBe(true);
    saveDeckMode(false);
    expect(loadDeckMode()).toBe(false);
  });

  it('round-trips the seen set', () => {
    expect(loadDeckSeen()).toEqual([]);
    saveDeckSeen([3, 1, 2]);
    expect(loadDeckSeen()).toEqual([3, 1, 2]);
  });

  it('returns a safe default for corrupt seen data', () => {
    store['asg:deck-seen'] = 'not json';
    expect(loadDeckSeen()).toEqual([]);
  });

  it('drops non-number entries from stored seen data', () => {
    store['asg:deck-seen'] = JSON.stringify([1, 'x', 2, null, 3]);
    expect(loadDeckSeen()).toEqual([1, 2, 3]);
  });

  it('works without storage: reads fall back, writes do not throw', () => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
    expect(loadDeckMode()).toBe(false);
    expect(loadDeckSeen()).toEqual([]);
    expect(() => saveDeckMode(true)).not.toThrow();
    expect(() => saveDeckSeen([1, 2])).not.toThrow();
  });
});
