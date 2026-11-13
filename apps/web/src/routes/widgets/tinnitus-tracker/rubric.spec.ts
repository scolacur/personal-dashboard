import { describe, expect, it } from 'vitest';
import { TINNITUS_MAX, TINNITUS_RUBRIC, tinnitusLabel } from '@dashboard/shared';

describe('tinnitus rubric (PD-711)', () => {
  it('labels every value 1–10 and leaves 0 blank', () => {
    expect(TINNITUS_RUBRIC).toHaveLength(TINNITUS_MAX + 1);
    expect(tinnitusLabel(0)).toBeNull();
    expect(tinnitusLabel(1)).toBe('Faint');
    expect(tinnitusLabel(2)).toBe('Faint');
    expect(tinnitusLabel(3)).toBe('Noticeable & maskable');
    expect(tinnitusLabel(4)).toBe('Noticeable & not maskable');
    expect(tinnitusLabel(10)).toBe('Unbearable');
  });
});
