import { describe, expect, it } from 'vitest';
import { CODER_AREAS } from '@dashboard/shared';
import { DEFAULT_CODER_NICKNAME, coderAgentName, coderAreaChip, coderAreaLabel } from './coder-area';

describe('coderAreaLabel', () => {
  it('maps every area id to its registry label', () => {
    for (const a of CODER_AREAS) expect(coderAreaLabel(a.id)).toBe(a.label);
  });
});

describe('coderAreaChip', () => {
  it('shows a ticket’s own area, not inherited', () => {
    expect(coderAreaChip({ coderArea: 'board' }, { coderArea: 'widgets' })).toEqual({
      area: 'board',
      label: 'Board',
      inherited: false,
    });
  });

  it('inherits the Epic’s area when the ticket has none, and marks it inherited', () => {
    expect(coderAreaChip({ coderArea: null }, { coderArea: 'widgets' })).toEqual({
      area: 'widgets',
      label: 'Widgets',
      inherited: true,
    });
  });

  it('falls back to general when neither the ticket nor its Epic has an area', () => {
    expect(coderAreaChip({ coderArea: null }, null)).toEqual({
      area: 'general',
      label: 'General',
      inherited: false,
    });
  });

  it('never marks an Epic’s own area as inherited', () => {
    expect(coderAreaChip({ coderArea: 'loop', isEpic: true }, null)).toEqual({
      area: 'loop',
      label: 'Loop',
      inherited: false,
    });
  });

  it('is not inherited when the ticket overrides an Epic that also has an area', () => {
    expect(coderAreaChip({ coderArea: 'infra' }, { coderArea: 'infra' }).inherited).toBe(false);
  });
});

describe('coderAgentName', () => {
  it('reads "Smith-<area> #<runId>" with the raw area id', () => {
    expect(coderAgentName('board', 212)).toBe('Smith-board #212');
  });

  it('uses the general fallback for a null area', () => {
    expect(coderAgentName(null, 7)).toBe(`${DEFAULT_CODER_NICKNAME}-general #7`);
  });

  it('accepts a custom nickname (for when PD-879 supplies one)', () => {
    expect(coderAgentName('loop', 99, 'Trinity')).toBe('Trinity-loop #99');
  });
});
