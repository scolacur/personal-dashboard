import { describe, it, expect } from 'vitest';
import { parseLines, dedupeLines, ideasToText } from './import-export';
import type { AcuteStrategyIdea } from '@dashboard/shared';

function idea(id: number, text: string): AcuteStrategyIdea {
  return { id, text, type: 'Acute', tags: [], created_at: 0, updated_at: 0 };
}

describe('parseLines', () => {
  it('splits on newlines, trims, and drops blanks', () => {
    expect(parseLines('  a \n\n b\nc  \n   \n')).toEqual(['a', 'b', 'c']);
  });

  it('handles CRLF line endings', () => {
    expect(parseLines('a\r\nb\r\n')).toEqual(['a', 'b']);
  });

  it('returns empty array for empty or whitespace-only text', () => {
    expect(parseLines('')).toEqual([]);
    expect(parseLines('   \n  \n')).toEqual([]);
  });
});

describe('dedupeLines', () => {
  it('skips lines matching an existing idea (case-insensitive, trimmed)', () => {
    const result = dedupeLines(['New one', ' existing '], ['Existing', 'Other']);
    expect(result.toAdd).toEqual(['New one']);
    expect(result.skipped).toBe(1);
  });

  it('skips a line matching an earlier line in the same batch', () => {
    const result = dedupeLines(['dup', 'DUP', 'unique'], []);
    expect(result.toAdd).toEqual(['dup', 'unique']);
    expect(result.skipped).toBe(1);
  });

  it('keeps the trimmed form of the first occurrence', () => {
    const result = dedupeLines(['  spaced  '], []);
    expect(result.toAdd).toEqual(['spaced']);
  });

  it('counts all duplicates when everything already exists', () => {
    const result = dedupeLines(['a', 'b'], ['A', 'B']);
    expect(result.toAdd).toEqual([]);
    expect(result.skipped).toBe(2);
  });

  it('adds everything when nothing is a duplicate', () => {
    const result = dedupeLines(['a', 'b', 'c'], []);
    expect(result.toAdd).toEqual(['a', 'b', 'c']);
    expect(result.skipped).toBe(0);
  });
});

describe('ideasToText', () => {
  it('writes one idea per line in list order', () => {
    expect(ideasToText([idea(1, 'first'), idea(2, 'second')])).toBe('first\nsecond');
  });

  it('replaces newlines inside an idea with a space so it stays one line', () => {
    const text = ideasToText([idea(1, 'line one\nline two'), idea(2, 'ok')]);
    expect(text).toBe('line one line two\nok');
    // Re-import yields the same number of ideas.
    expect(parseLines(text)).toHaveLength(2);
  });

  it('round-trips: exporting then re-importing adds nothing', () => {
    const ideas = [idea(1, 'alpha'), idea(2, 'beta')];
    const text = ideasToText(ideas);
    const result = dedupeLines(parseLines(text), ideas.map((i) => i.text));
    expect(result.toAdd).toEqual([]);
    expect(result.skipped).toBe(2);
  });

  it('returns empty string for no ideas', () => {
    expect(ideasToText([])).toBe('');
  });
});
