import { describe, expect, it } from 'vitest';
import {
  COLOR_PRESETS,
  contrastRatio,
  contrastText,
  isHexColor,
  normalizeHexColor,
  relativeLuminance,
} from '@dashboard/shared';

// The shared colour helpers behind `ColorPicker.svelte` (PD-975, Drug log widget). Tested here
// because `packages/shared` has no test runner of its own.

describe('normalizeHexColor / isHexColor', () => {
  it.each([
    ['#2E9E5B', '#2e9e5b'],
    ['2e9e5b', '#2e9e5b'],
    ['  #abc ', '#aabbcc'],
    ['fff', '#ffffff'],
  ])('%s → %s', (raw, want) => {
    expect(normalizeHexColor(raw)).toBe(want);
  });

  it.each(['', '#12345', '#gggggg', 'green', '#1234567', 42, null])('rejects %s', (raw) => {
    expect(normalizeHexColor(raw)).toBeNull();
  });

  it('isHexColor accepts only the canonical lower-case form', () => {
    expect(isHexColor('#2e9e5b')).toBe(true);
    expect(isHexColor('#2E9E5B')).toBe(false);
    expect(isHexColor('#abc')).toBe(false);
  });
});

describe('contrast', () => {
  it('luminance endpoints and ratio', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21);
  });

  it('picks black on light fills and white on dark ones', () => {
    expect(contrastText('#ffff5c')).toBe('#000000');
    expect(contrastText('#f0f0f0')).toBe('#000000');
    expect(contrastText('#1d2a6b')).toBe('#ffffff');
    expect(contrastText('#000000')).toBe('#ffffff');
  });

  it('every preset is canonical, unique, and carries its label at ≥ 4.5:1', () => {
    const hexes = COLOR_PRESETS.map((p) => p.hex);
    expect(new Set(hexes).size).toBe(hexes.length);
    for (const hex of hexes) {
      expect(isHexColor(hex)).toBe(true);
      expect(contrastRatio(hex, contrastText(hex))).toBeGreaterThanOrEqual(4.5);
    }
  });
});
