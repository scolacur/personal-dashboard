import { describe, expect, it } from 'vitest';
import { MAX_LABEL_LENGTH, normalizeLabel } from './label';

describe('normalizeLabel', () => {
  it('returns a plain label unchanged', () => {
    expect(normalizeLabel('Morning run')).toBe('Morning run');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeLabel('  Morning run  ')).toBe('Morning run');
  });

  it('collapses internal whitespace runs to a single space', () => {
    expect(normalizeLabel('Morning   run\tnow')).toBe('Morning run now');
  });

  it('returns null for an empty string', () => {
    expect(normalizeLabel('')).toBeNull();
  });

  it('returns null for a whitespace-only string', () => {
    expect(normalizeLabel('   \t  ')).toBeNull();
  });

  it('keeps a label of exactly the maximum length', () => {
    const label = 'a'.repeat(MAX_LABEL_LENGTH);
    expect(label.length).toBe(80);
    expect(normalizeLabel(label)).toBe(label);
  });

  it('returns null for a label one character over the maximum length', () => {
    const label = 'a'.repeat(MAX_LABEL_LENGTH + 1);
    expect(label.length).toBe(81);
    expect(normalizeLabel(label)).toBeNull();
  });
});
