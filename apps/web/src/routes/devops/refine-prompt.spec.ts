import { describe, it, expect, vi } from 'vitest';
import { needsUnrefinePrompt, resolveUnrefineChoice } from './refine-prompt';

const refined = { refined: true, body: 'original body' };
const unrefined = { refined: false, body: 'original body' };

describe('needsUnrefinePrompt (D-097)', () => {
  it('prompts for a refined ticket whose body changed', () => {
    expect(needsUnrefinePrompt(refined, 'new body')).toBe(true);
  });

  it('does not prompt when the body is byte-identical', () => {
    expect(needsUnrefinePrompt(refined, 'original body')).toBe(false);
  });

  it('does not prompt for a non-refined ticket, even on a changed body', () => {
    expect(needsUnrefinePrompt(unrefined, 'new body')).toBe(false);
  });

  it('treats null and empty-string bodies distinctly from the stored value', () => {
    expect(needsUnrefinePrompt({ refined: true, body: null }, '')).toBe(true);
    expect(needsUnrefinePrompt({ refined: true, body: null }, null)).toBe(false);
  });
});

describe('resolveUnrefineChoice (D-097)', () => {
  it('returns undefined (no refined field sent) when no prompt is warranted', () => {
    const ask = vi.fn(() => true);
    expect(resolveUnrefineChoice(refined, 'original body', ask)).toBeUndefined();
    expect(resolveUnrefineChoice(unrefined, 'new body', ask)).toBeUndefined();
    expect(ask).not.toHaveBeenCalled();
  });

  it('asks "Mark this unrefined?" only for a refined ticket with a changed body', () => {
    const ask = vi.fn(() => true);
    resolveUnrefineChoice(refined, 'new body', ask);
    expect(ask).toHaveBeenCalledOnce();
    expect(ask).toHaveBeenCalledWith('Mark this unrefined?');
  });

  it('answering Yes (the default) clears refined → false', () => {
    expect(resolveUnrefineChoice(refined, 'new body', () => true)).toBe(false);
  });

  it('answering No keeps refined → true', () => {
    expect(resolveUnrefineChoice(refined, 'new body', () => false)).toBe(true);
  });
});
