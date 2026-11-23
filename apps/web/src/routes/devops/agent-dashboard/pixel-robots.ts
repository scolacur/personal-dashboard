import type { ActiveAgentKind } from '@dashboard/shared';

/**
 * PD-819: the 8-bit robot sprites for the Agent Dashboard (PD-682).
 *
 * Each sprite is a character grid; every non-`.` cell becomes one 1×1 `<rect>` in an SVG, so the
 * art stays pixel-crisp at any size and every colour is a CSS class (themeable, and the body takes
 * the run's project colour). Cells are tagged with a PART so animations can move a part (blinking
 * eyes, a sweeping magnifying glass, rolling treads) without a second sprite.
 *
 * There are several sprite SETS (body designs). Each set is a base robot plus one overlay per kind
 * that adds that kind's accessory: Evaluator a magnifying glass, Auditor a green accounting visor.
 *
 * Palette:
 *   D outline · B body (project colour) · S face screen · E eye · M mouth / grille · A antenna light
 *   L chest light · K lens rim · G lens glass · W glint · H handle · V visor band · v visor brim
 *   T tread · t tread stud
 */

export const SPRITE_W = 20;
export const SPRITE_H = 16;

export const SPRITE_SETS = ['classic', 'chunky', 'tread'] as const;
export type SpriteSet = (typeof SPRITE_SETS)[number];

export type PixelPart = 'body' | 'eyes' | 'antenna' | 'tool' | 'tread';

export interface Pixel {
  x: number;
  y: number;
  c: string;
  part: PixelPart;
}

/** Right-pad every row to SPRITE_W so accessories have room and rows can be written short. */
function grid(rows: string[]): string[] {
  return rows.map((r) => r.padEnd(SPRITE_W, '.'));
}

interface SpriteSource {
  base: string[];
  /** Same grid: `.` keeps the base cell, `_` erases it, anything else paints over it. An overlay
   *  need only be as tall as its last painted row. */
  overlays: Record<ActiveAgentKind, string[]>;
}

// The original: square head, face screen, two eyes, antenna.
const CLASSIC: SpriteSource = {
  base: grid([
    '.......AA',
    '.......DD',
    '...DDDDDDDDDD',
    '...DBBBBBBBBD',
    '...DBSSSSSSBD',
    '...DBSESSESBD',
    '...DBSSMMSSBD',
    '...DBBBBBBBBD',
    '...DDDDDDDDDD',
    '......DDDD',
    '...DDDDDDDDDD',
    '.D.DBBBBBBBBD.D',
    '.D.DBBLLLLBBD.D',
    '.D.DBBBBBBBBD.D',
    '...DDDDDDDDDD',
    '....DD....DD',
  ]),
  overlays: {
    robot: [],
    evaluator: grid([
      '', '', '', '', '', '',
      '................KKK',
      '...............KGGGK',
      '...............KGWGK',
      '...............KGGGK',
      '................KKK',
      '..............HH____',
      '..............H',
      '.............._',
    ]),
    auditor: grid(['', '', '', '..VVVVVVVVVVVV', '.vvvvvvvvvvvvvv']),
  },
};

// A dome-headed cyclops with one wide visor eye that scans side to side.
const CHUNKY: SpriteSource = {
  base: grid([
    '........A',
    '........D',
    '.....DDDDDDD',
    '....DBBBBBBBD',
    '...DBBBBBBBBBD',
    '...DBSSSSSSSBD',
    '...DBSSEEESSBD',
    '...DBSSSSSSSBD',
    '...DBBBBBBBBBD',
    '....DDDDDDDDD',
    '..DD.DBBBBBD.DD',
    '..DB.DBLLLBD.BD',
    '..DD.DBBBBBD.DD',
    '.....DDDDDDD',
    '......D...D',
    '.....DD...DD',
  ]),
  overlays: {
    robot: [],
    evaluator: grid([
      '', '', '', '', '',
      '................KKK',
      '...............KGGGK',
      '...............KGWGK',
      '...............KGGGK',
      '................KKK',
      '...............H',
      '..............H',
    ]),
    auditor: grid(['', '', '', '', '..VVVVVVVVVVVVV', '.vvvvvvvvvvvvvvv']),
  },
};

// A boxy bot on tank treads: two antennae, big square eyes, a grille mouth.
const TREAD: SpriteSource = {
  base: grid([
    '...A........A',
    '...D........D',
    '...DDDDDDDDDD',
    '...DBBBBBBBBD',
    '...DBEEBBEEBD',
    '...DBEEBBEEBD',
    '...DBBMMMMBBD',
    '...DDDDDDDDDD',
    '......DBBD',
    '..DDDDDDDDDDDD',
    '..DBBBBLLBBBBD',
    '..DBBBBBBBBBBD',
    '..DDDDDDDDDDDD',
    '.TTTTTTTTTTTTTT',
    '.TtTTtTTtTTtTTT',
    '..TTTTTTTTTTTT',
  ]),
  overlays: {
    robot: [],
    evaluator: grid([
      '', '', '', '',
      '................KKK',
      '...............KGGGK',
      '...............KGWGK',
      '...............KGGGK',
      '................KKK',
      '...............H',
      '..............HH',
    ]),
    auditor: grid(['', '', '..VVVVVVVVVVVV', '.vvvvvvvvvvvvvv']),
  },
};

const SOURCES: Record<SpriteSet, SpriteSource> = { classic: CLASSIC, chunky: CHUNKY, tread: TREAD };

function partOf(c: string, kind: ActiveAgentKind): PixelPart {
  if (c === 'E') return 'eyes';
  if (c === 'A') return 'antenna';
  if (c === 't') return 'tread';
  if (kind === 'evaluator' && 'KGWH'.includes(c)) return 'tool';
  return 'body';
}

/** A kind's sprite in a given set, as a flat pixel list. */
export function spriteFor(kind: ActiveAgentKind, set: SpriteSet = 'classic'): Pixel[] {
  const { base, overlays } = SOURCES[set];
  const overlay = overlays[kind];
  const pixels: Pixel[] = [];
  for (let y = 0; y < SPRITE_H; y++) {
    for (let x = 0; x < SPRITE_W; x++) {
      let c = base[y][x];
      const o = overlay[y]?.[x];
      if (o === '_') c = '.';
      else if (o && o !== '.') c = o;
      if (c !== '.') pixels.push({ x, y, c, part: partOf(c, kind) });
    }
  }
  return pixels;
}

/** Exposed for the sprite-integrity test. */
export const _SPRITE_SOURCES = SOURCES;
