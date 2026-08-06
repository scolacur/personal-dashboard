import { describe, expect, it } from 'vitest';
import type { BstMatch } from '@dashboard/shared';
import { groupMatches, splitByConfidence } from './matches';

let nextId = 1;
function match(over: Partial<BstMatch> & { item: string }): BstMatch {
  return {
    id: nextId++,
    listingId: 1,
    threadId: 't3_x',
    commentId: `c${nextId}`,
    permalink: 'https://reddit.com/r/modular/comments/x/_/c1',
    author: 'someone',
    authorUrl: 'https://reddit.com/user/someone',
    intent: 'WTS',
    confidence: 'confirmed',
    matchedOn: over.item.toLowerCase(),
    excerpt: 'WTS thing $100',
    matchedAt: 0,
    dismissedAt: null,
    manufacturer: null,
    listingType: 'WTS',
    saleStatus: 'for-sale',
    ...over,
  };
}

describe('groupMatches', () => {
  it('groups by manufacturer + item so duplicate listings do not double up a comment', () => {
    const out = groupMatches([
      match({ item: 'Maths', manufacturer: 'Make Noise', listingId: 1 }),
      match({ item: 'Maths', manufacturer: 'Make Noise', listingId: 2 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe('Make Noise Maths');
    expect(out[0].items).toHaveLength(2);
  });

  // Someone offering gear on Steve's want list is the payoff of the whole scan; recency would
  // bury it under sale-side noise.
  it('puts a seller for a wanted item above ordinary sale-side traffic', () => {
    const out = groupMatches([
      match({ item: 'Chronoblob', listingType: 'WTS', saleStatus: 'feelers', intent: 'WTB' }),
      match({ item: 'Rhodes', listingType: 'WTB', saleStatus: null, intent: 'WTS' }),
    ]);
    expect(out.map((g) => g.label)).toEqual(['Rhodes', 'Chronoblob']);
    expect(out[0].significance).toBe('high');
  });

  it('takes a group significance from its most significant match', () => {
    const out = groupMatches([
      match({ item: 'Maths', listingType: 'WTB', saleStatus: null, intent: 'unknown' }),
      match({ item: 'Maths', listingType: 'WTB', saleStatus: null, intent: 'WTS' }),
    ]);
    expect(out[0].significance).toBe('high');
  });
});

describe('splitByConfidence', () => {
  it('separates the two halves, grouping each on its own', () => {
    const { confirmed, possible } = splitByConfidence([
      match({ item: 'Maths', confidence: 'confirmed' }),
      match({ item: 'Mix', confidence: 'possible' }),
      match({ item: 'Mix', confidence: 'possible' }),
    ]);
    expect(confirmed.map((g) => g.label)).toEqual(['Maths']);
    expect(possible.map((g) => g.label)).toEqual(['Mix']);
    expect(possible[0].items).toHaveLength(2);
  });

  // The same item can be confirmed in one comment and merely possible in another. Those belong
  // in different sections — the whole point is that the two are read differently.
  it('splits one item across both halves when the evidence differs by comment', () => {
    const { confirmed, possible } = splitByConfidence([
      match({ item: 'Mix', manufacturer: '2hp', confidence: 'confirmed' }),
      match({ item: 'Mix', manufacturer: '2hp', confidence: 'possible' }),
    ]);
    expect(confirmed[0].items).toHaveLength(1);
    expect(possible[0].items).toHaveLength(1);
  });

  it('returns empty halves rather than throwing on no matches', () => {
    expect(splitByConfidence([])).toEqual({ confirmed: [], possible: [] });
  });
});
