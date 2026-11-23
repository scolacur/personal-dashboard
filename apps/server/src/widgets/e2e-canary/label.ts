/** The canary's item-label rule (widgets/e2e-canary/PROJECT.md): 1–80 characters after trimming. */
export const MAX_LABEL_LENGTH = 80;

/**
 * Normalize a raw item label: trim it and collapse internal whitespace runs to one space.
 * Returns null when the result is empty or longer than {@link MAX_LABEL_LENGTH}.
 */
export function normalizeLabel(raw: string): string | null {
  const label = raw.trim().replace(/\s+/g, ' ');
  if (label.length === 0 || label.length > MAX_LABEL_LENGTH) return null;
  return label;
}
