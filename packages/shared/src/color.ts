/**
 * Colour helpers shared by the server (validating a stored colour) and the web (the reusable
 * `ColorPicker`, and any label drawn on a user-chosen fill). Generic on purpose: the Drug Log
 * (PD-975) is the first caller, and the Epic card border colour picker will be the second.
 *
 * A colour on the wire and in the DB is always the canonical `#rrggbb` lower-case form that
 * {@link normalizeHexColor} returns.
 */

/** A preset swatch. `name` is the accessible label; `hex` is canonical `#rrggbb`. */
export interface ColorPreset {
  name: string;
  hex: string;
}

/**
 * The picker's preset swatches. Mid-lightness and moderately saturated, so each reads as a fill on
 * both the light (`--surface: #f0f0f0`) and dark (`--surface: #2e2e2e`) themes and carries either
 * black or white text legibly (see {@link contrastText}).
 */
export const COLOR_PRESETS: readonly ColorPreset[] = [
  { name: 'Green', hex: '#2e9e5b' },
  { name: 'Teal', hex: '#14918c' },
  { name: 'Blue', hex: '#2f6fb5' },
  { name: 'Indigo', hex: '#5b5fc7' },
  { name: 'Purple', hex: '#8e4fb8' },
  { name: 'Pink', hex: '#d6336c' },
  { name: 'Red', hex: '#cf3e3e' },
  { name: 'Orange', hex: '#e07020' },
  { name: 'Amber', hex: '#d99a00' },
  { name: 'Olive', hex: '#7f8c2a' },
  { name: 'Brown', hex: '#8a5a3c' },
  { name: 'Slate', hex: '#5f6b7a' },
];

const HEX6 = /^#[0-9a-f]{6}$/;

/** True for a canonical `#rrggbb` (lower-case) string — the only form stored or sent. */
export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX6.test(value);
}

/**
 * Normalise what a person might type into canonical `#rrggbb`: trims, adds a missing `#`, expands
 * the `#rgb` shorthand and lower-cases. Null when it isn't a hex colour at all.
 */
export function normalizeHexColor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().toLowerCase();
  if (!s.startsWith('#')) s = `#${s}`;
  if (/^#[0-9a-f]{3}$/.test(s)) s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return HEX6.test(s) ? s : null;
}

/** WCAG relative luminance (0 = black, 1 = white) of a hex colour. */
export function relativeLuminance(hex: string): number {
  const n = normalizeHexColor(hex);
  if (n === null) throw new Error(`Not a hex colour: ${hex}`);
  const channel = (i: number): number => {
    const c = parseInt(n.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG contrast ratio between two colours, 1–21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export const CONTRAST_DARK = '#000000';
export const CONTRAST_LIGHT = '#ffffff';

/** The text colour — black or white — that contrasts more with `background`. */
export function contrastText(background: string): string {
  return contrastRatio(background, CONTRAST_DARK) >= contrastRatio(background, CONTRAST_LIGHT)
    ? CONTRAST_DARK
    : CONTRAST_LIGHT;
}
