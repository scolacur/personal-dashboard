import { describe, it, expect } from 'vitest';
import { deriveAllTags, filterIdeas, pickRandom } from './utils';
import type { AcuteStrategyIdea } from '@dashboard/shared';

const ideas: AcuteStrategyIdea[] = [
  { id: 1, text: 'Idea 1', type: 'Acute', tags: ['synth', 'ambient'], created_at: 0, updated_at: 0 },
  { id: 2, text: 'Idea 2', type: 'Oblique', tags: ['synth', 'drone'], created_at: 0, updated_at: 0 },
  { id: 3, text: 'Idea 3', type: 'Inspiration', tags: [], created_at: 0, updated_at: 0 },
];

describe('deriveAllTags', () => {
  it('collects unique tags from all ideas, sorted', () => {
    expect(deriveAllTags(ideas)).toEqual(['ambient', 'drone', 'synth']);
  });

  it('returns empty array for an idea with no tags', () => {
    expect(deriveAllTags([ideas[2]])).toEqual([]);
  });

  it('returns empty array for empty ideas list', () => {
    expect(deriveAllTags([])).toEqual([]);
  });

  it('deduplicates tags that appear in multiple ideas', () => {
    const result = deriveAllTags(ideas);
    const synths = result.filter((t) => t === 'synth');
    expect(synths).toHaveLength(1);
  });
});

describe('filterIdeas', () => {
  it('returns all ideas when type is All and tag is empty', () => {
    expect(filterIdeas(ideas, 'All', '')).toHaveLength(3);
  });

  it('filters by type', () => {
    const result = filterIdeas(ideas, 'Acute', '');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(1);
  });

  it('filters by tag (case-insensitive)', () => {
    const result = filterIdeas(ideas, 'All', 'SYNTH');
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.id)).toEqual(expect.arrayContaining([1, 2]));
  });

  it('filters by both type and tag', () => {
    const result = filterIdeas(ideas, 'Oblique', 'drone');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(2);
  });

  it('returns empty array when no ideas match the tag', () => {
    expect(filterIdeas(ideas, 'All', 'nonexistent')).toHaveLength(0);
  });

  it('ignores whitespace-only tag filter', () => {
    expect(filterIdeas(ideas, 'All', '   ')).toHaveLength(3);
  });

  it('returns empty array when type filter excludes all ideas', () => {
    expect(filterIdeas(ideas, 'Acute', 'drone')).toHaveLength(0);
  });
});

describe('pickRandom', () => {
  it('returns null for empty pool', () => {
    expect(pickRandom([])).toBeNull();
  });

  it('returns the only element for a single-element pool', () => {
    expect(pickRandom([ideas[0]])).toBe(ideas[0]);
  });

  it('returns an element that exists in the pool', () => {
    const result = pickRandom(ideas);
    expect(ideas).toContain(result);
  });
});
