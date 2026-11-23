import type { ActiveAgentKind } from '@dashboard/shared';

/**
 * PD-819: the 8-bit robot sprites for the Agent Dashboard (PD-682).
 *
 * Each sprite is a character grid; every non-`.` cell becomes one 1×1 `<rect>` in an SVG, so the
 * art stays pixel-crisp at any size and every colour is a CSS class (themeable, and the body takes
 * the run's project colour). Cells are also tagged with a PART so the animations can move a part
 * (blinking eyes, a sweeping magnifying glass) without a second sprite.
 *
 * Palette:
 *   D outline · B body (project colour) · S face screen · E eye · M mouth · A antenna light
 *   L chest light · K lens rim · G lens glass · W glint · H handle · V visor band · v visor brim
 *   Z sleep "z"
 */

export const SPRITE_W = 20;
export const SPRITE_H = 16;

export type PixelPart = 'body' | 'eyes' | 'antenna' | 'tool';

export interface Pixel {
  x: number;
  y: number;
  c: string;
  part: PixelPart;
}

/** A fairly generic robot — the base every kind builds on. Padded to SPRITE_W on the right so
 *  accessories have room. */
const BASE: string[] = [
  '.......AA...........',
  '.......DD...........',
  '...DDDDDDDDDD.......',
  '...DBBBBBBBBD.......',
  '...DBSSSSSSBD.......',
  '...DBSESSESBD.......',
  '...DBSSMMSSBD.......',
  '...DBBBBBBBBD.......',
  '...DDDDDDDDDD.......',
  '......DDDD..........',
  '...DDDDDDDDDD.......',
  '.D.DBBBBBBBBD.D.....',
  '.D.DBBLLLLBBD.D.....',
  '.D.DBBBBBBBBD.D.....',
  '...DDDDDDDDDD.......',
  '....DD....DD........',
];

/**
 * Overlays: same grid, `.` keeps the base cell, `_` erases it, anything else paints over it.
 * Lowercase-only rows are fine; an overlay need only be as tall as its last painted row.
 */
const OVERLAYS: Record<ActiveAgentKind | 'sleeping', string[]> = {
  robot: [],
  // Holds a magnifying glass up in the right hand — reviewing the PR.
  evaluator: [
    '....................',
    '....................',
    '....................',
    '....................',
    '....................',
    '....................',
    '................KKK.',
    '...............KGGGK',
    '...............KGWGK',
    '...............KGGGK',
    '................KKK.',
    '..............HH____',
    '..............H.....',
    '.............._.....',
  ],
  // A green accounting visor across the brow — auditing the books.
  auditor: [
    '....................',
    '....................',
    '....................',
    '..VVVVVVVVVVVV......',
    '.vvvvvvvvvvvvvv.....',
  ],
  // Idle fleet: eyes shut, a "z" drifting up.
  sleeping: [
    '..............ZZ....',
    '...............Z....',
    '..............ZZ....',
    '....................',
    '....................',
    '......S..S..........',
  ],
};

function partOf(c: string, kind: string): PixelPart {
  if (c === 'E' || c === 'M') return 'eyes';
  if (c === 'A' || c === 'Z') return 'antenna';
  if (kind === 'evaluator' && 'KGWH'.includes(c)) return 'tool';
  return 'body';
}

/** The sprite for a kind (or the idle "sleeping" robot) as a flat pixel list. */
export function spriteFor(kind: ActiveAgentKind | 'sleeping'): Pixel[] {
  const overlay = OVERLAYS[kind];
  const pixels: Pixel[] = [];
  for (let y = 0; y < SPRITE_H; y++) {
    for (let x = 0; x < SPRITE_W; x++) {
      let c = BASE[y][x];
      const o = overlay[y]?.[x];
      if (o === '_') c = '.';
      else if (o && o !== '.') c = o;
      if (c !== '.') pixels.push({ x, y, c, part: partOf(c, kind) });
    }
  }
  return pixels;
}

/** Exposed for the sprite-integrity test. */
export const _SPRITE_SOURCES = { BASE, OVERLAYS };
