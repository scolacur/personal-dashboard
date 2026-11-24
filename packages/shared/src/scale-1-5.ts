/**
 * The shared 1–5 colour scale, red (1) to green (5): the Sleep Journal's rested score and the Mood &
 * Energy widget's mood both paint with it, so "bad → good" looks the same everywhere.
 *
 * Moved here from `sleep-journal.ts` (PD-95, Mood & Energy widget) so neither widget's shared module
 * owns a colour the other uses. Mid-tone hues, so they read on both the light and dark themes, and
 * dark ink ({@link SCALE_1_5_INK}) reads on all of them.
 */

export const SCALE_1_5_MIN = 1;
export const SCALE_1_5_MAX = 5;

export const SCALE_1_5_COLORS: Readonly<Record<number, string>> = {
  1: '#d64541',
  2: '#ec8a3c',
  3: '#e3c13b',
  4: '#9ccc5a',
  5: '#3fae68',
};

/** Ink for text drawn on a scale colour. */
export const SCALE_1_5_INK = '#1f1f1f';

/** The colour for a 1–5 value. Out-of-range values get the midpoint's colour. */
export function scale15Color(value: number): string {
  return SCALE_1_5_COLORS[value] ?? SCALE_1_5_COLORS[3];
}
