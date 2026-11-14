import type { AcuteStrategyIdea } from '@dashboard/shared';

/**
 * Parse raw import text into candidate idea lines (T69): split on newlines,
 * trim each line, and drop blank ones. One idea per line.
 */
export function parseLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Normalisation key for dedupe: whitespace-trimmed, case-insensitive. Mirrors the server. */
function dedupeKey(text: string): string {
  return text.trim().toLowerCase();
}

export interface DedupePreview {
  /** Trimmed lines that would be added, in order. */
  toAdd: string[];
  /** Count of lines skipped as duplicates (of an existing idea or an earlier line). */
  skipped: number;
}

/**
 * Dedupe parsed lines against existing idea texts and against earlier lines in
 * the same batch (case-insensitive, whitespace-trimmed). Pure, so the manage
 * face can preview "N to add, M duplicates skipped" before committing.
 */
export function dedupeLines(lines: string[], existingTexts: string[]): DedupePreview {
  const seen = new Set(existingTexts.map(dedupeKey));
  const toAdd: string[] = [];
  let skipped = 0;
  for (const raw of lines) {
    const text = raw.trim();
    if (!text) continue;
    const key = dedupeKey(text);
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    toAdd.push(text);
  }
  return { toAdd, skipped };
}

/**
 * Serialise ideas to the export format (T69): every idea's text, one per line,
 * in list order. A newline inside an idea is replaced with a space so the file
 * always re-imports as the same number of ideas.
 */
export function ideasToText(ideas: AcuteStrategyIdea[]): string {
  return ideas.map((idea) => idea.text.replace(/\r?\n/g, ' ')).join('\n');
}
