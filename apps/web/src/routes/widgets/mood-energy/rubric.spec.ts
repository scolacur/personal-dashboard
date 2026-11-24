import { describe, expect, it } from 'vitest';
import { energyColor, energyLabel, ENERGY_RUBRIC, moodLabel, MOOD_RUBRIC, scale15Color, SCALE_1_5_COLORS } from '@dashboard/shared';

describe('mood & energy rubrics', () => {
  it('labels every value 1–5', () => {
    expect(MOOD_RUBRIC).toHaveLength(6);
    expect(ENERGY_RUBRIC).toHaveLength(6);
    expect([1, 2, 3, 4, 5].map(moodLabel)).toEqual(['Unpleasant', 'Slightly Unpleasant', 'Neutral', 'Pleasant', 'Very Pleasant']);
    expect([1, 2, 3, 4, 5].map(energyLabel)).toEqual(['Drained', 'Low', 'Steady', 'Energized', 'Very Energized']);
    expect(moodLabel(0)).toBeNull();
  });

  it('colours mood on the shared red→green scale and energy on its own ramp', () => {
    expect(scale15Color(1)).toBe(SCALE_1_5_COLORS[1]);
    expect(scale15Color(9)).toBe(SCALE_1_5_COLORS[3]);
    const energy = [1, 2, 3, 4, 5].map(energyColor);
    expect(new Set(energy).size).toBe(5);
    expect(energy.some((c) => Object.values(SCALE_1_5_COLORS).includes(c))).toBe(false);
  });
});
