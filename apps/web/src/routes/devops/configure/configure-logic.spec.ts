import { describe, it, expect } from 'vitest';
import {
  bootLabel,
  formatMs,
  formatSettingValue,
  isOverridden,
  liveBadge,
  msInputUnit,
  parseInputText,
  toInputText,
} from './configure-logic';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('formatMs (PD-1006)', () => {
  it('reads in the largest natural unit', () => {
    expect(formatMs(0)).toBe('0');
    expect(formatMs(15_000)).toBe('15 s');
    expect(formatMs(3 * MIN)).toBe('3 min');
    expect(formatMs(24 * HOUR)).toBe('24 h');
    expect(formatMs(90 * MIN)).toBe('1.5 h');
    expect(formatMs(7 * 24 * HOUR)).toBe('168 h');
  });
});

describe('ms inputs in human units', () => {
  const window = { unit: 'ms' as const, default: 24 * HOUR };
  const poll = { unit: 'ms' as const, default: 3 * MIN };
  const fast = { unit: 'ms' as const, default: 5_000 };

  it('picks the input unit from the default', () => {
    expect(msInputUnit(window.default)).toBe('h');
    expect(msInputUnit(poll.default)).toBe('min');
    expect(msInputUnit(fast.default)).toBe('s');
  });

  it('round-trips ms through the input text', () => {
    expect(toInputText(window, 6 * HOUR)).toBe('6');
    expect(parseInputText(window, '6')).toBe(6 * HOUR);
    expect(parseInputText(window, '1.5')).toBe(90 * MIN);
    expect(toInputText(poll, 90_000)).toBe('1.5');
    expect(parseInputText(poll, '1.5')).toBe(90_000);
    expect(parseInputText(fast, '10')).toBe(10_000);
  });

  it('leaves counts alone and rejects empty / non-numeric text', () => {
    const turns = { unit: 'turns' as const, default: 200 };
    expect(toInputText(turns, 1500)).toBe('1500');
    expect(parseInputText(turns, ' 800 ')).toBe(800);
    expect(parseInputText(turns, '')).toBeNull();
    expect(parseInputText(turns, 'lots')).toBeNull();
    expect(toInputText(turns, null)).toBe('');
  });
});

describe('row text', () => {
  it('formats values by unit', () => {
    expect(formatSettingValue(1500, 'turns')).toBe('1,500 turns');
    expect(formatSettingValue(0, 'tokens')).toBe('0 tokens');
    expect(formatSettingValue(3, 'count')).toBe('3');
    expect(formatSettingValue(2 * MIN, 'ms')).toBe('2 min');
    expect(formatSettingValue(null, 'count')).toBe('—');
  });

  it('badges live vs restart-only settings', () => {
    expect(liveBadge({ live: true })).toBe('live');
    expect(liveBadge({ live: false })).toBe('applies on worker restart');
  });

  it('labels the boot value with its source, or says the worker has not reported', () => {
    expect(bootLabel({ boot: 1500, bootSource: 'env', unit: 'turns', default: 200 })).toBe('1,500 turns (env)');
    expect(bootLabel({ boot: 200, bootSource: 'default', unit: 'turns', default: 200 })).toBe('200 turns (default)');
    expect(bootLabel({ boot: null, bootSource: null, unit: 'count', default: 3 })).toBe('3 (default; worker not reported yet)');
  });

  it('marks a row overridden only when the override differs from env/default', () => {
    expect(isOverridden({ override: null, boot: 1500, default: 200 })).toBe(false);
    expect(isOverridden({ override: 800, boot: 1500, default: 200 })).toBe(true);
    expect(isOverridden({ override: 1500, boot: 1500, default: 200 })).toBe(false);
    expect(isOverridden({ override: 5, boot: null, default: 3 })).toBe(true);
  });
});
