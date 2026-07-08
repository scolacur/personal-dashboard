import type { AcuteStrategyIdea, IdeaType } from '@dashboard/shared';

export function deriveAllTags(ideas: AcuteStrategyIdea[]): string[] {
  return [...new Set(ideas.flatMap((i) => i.tags))].sort();
}

export function filterIdeas(
  ideas: AcuteStrategyIdea[],
  typeFilter: 'All' | IdeaType,
  tagFilter: string,
): AcuteStrategyIdea[] {
  return ideas.filter((idea) => {
    if (typeFilter !== 'All' && idea.type !== typeFilter) return false;
    if (tagFilter.trim()) {
      const needle = tagFilter.trim().toLowerCase();
      if (!idea.tags.some((t) => t.toLowerCase() === needle)) return false;
    }
    return true;
  });
}

export function pickRandom<T>(pool: T[]): T | null {
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}
