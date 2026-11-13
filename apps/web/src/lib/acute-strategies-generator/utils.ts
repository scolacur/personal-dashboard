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

export type ParseIdeaFormResult =
  | { ok: true; data: { text: string; type: IdeaType; tags: string[] } }
  | { ok: false; error: string };

/**
 * Validate and normalise the raw IdeaEditModal form fields into the payload the
 * create/update API expects. Kept here (not inline in the component) so the one
 * creation path is unit-testable — shared by both "Save" and "Save and add
 * another" (T546).
 */
export function parseIdeaForm(
  rawText: string,
  type: IdeaType,
  rawTags: string,
): ParseIdeaFormResult {
  const text = rawText.trim();
  if (!text) return { ok: false, error: 'Text is required.' };
  const tags = rawTags
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  return { ok: true, data: { text, type, tags } };
}
