import { describe, it, expect } from 'vitest';
import { normalize } from './normalize';

describe('normalize', () => {
  it('lowercases artist and title, no remixer by default', () => {
    expect(normalize({ artist: 'Bicep', title: 'Glue' })).toEqual({
      normArtist: 'bicep',
      normTitle: 'glue',
      normRemixer: null,
    });
  });

  it('folds diacritics on both fields', () => {
    expect(normalize({ artist: 'Sigur Rós', title: 'Glósóli' })).toEqual({
      normArtist: 'sigur ros',
      normTitle: 'glosoli',
      normRemixer: null,
    });
  });

  describe('feat. extraction', () => {
    it('pulls "(feat. X)" out of the title and onto the artist', () => {
      expect(normalize({ artist: 'Calvin Harris', title: 'Feels (feat. Pharrell)' })).toEqual({
        normArtist: 'calvin harris & pharrell',
        normTitle: 'feels',
        normRemixer: null,
      });
    });

    it.each(['feat.', 'feat', 'featuring', 'ft.', 'ft'])('recognises "%s"', (token) => {
      const r = normalize({ artist: 'Host', title: `Song (${token} Guest)` });
      expect(r.normArtist).toBe('guest & host');
      expect(r.normTitle).toBe('song');
    });
  });

  describe('remix extraction', () => {
    it('captures a parenthetical remix into normRemixer and strips it from the title', () => {
      expect(normalize({ artist: 'Bicep', title: 'Glue (Maxxi Soundsystem Remix)' })).toEqual({
        normArtist: 'bicep',
        normTitle: 'glue',
        normRemixer: 'maxxi soundsystem remix',
      });
    });

    it.each(['Remix', 'Mix', 'Edit', 'Version', 'Dub', 'VIP', 'Bootleg', 'Rework'])(
      'treats "%s" as a remixer keyword',
      (kw) => {
        const r = normalize({ artist: 'A', title: `Track (Some ${kw})` });
        expect(r.normTitle).toBe('track');
        expect(r.normRemixer).toBe(`some ${kw.toLowerCase()}`);
      },
    );

    it('handles feat. and remix together', () => {
      expect(
        normalize({ artist: 'Disclosure', title: 'Latch (feat. Sam Smith) (Tensnake Remix)' }),
      ).toEqual({
        normArtist: 'disclosure & sam smith',
        normTitle: 'latch',
        normRemixer: 'tensnake remix',
      });
    });
  });

  describe('collaboration separators', () => {
    it.each([
      ['Bicep x Hammer', 'bicep & hammer'],
      ['A vs B', 'a & b'],
      ['A vs. B', 'a & b'],
      ['A with B', 'a & b'],
      ['A & B', 'a & b'],
      ['A, B', 'a & b'],
    ])('normalises "%s" to "%s"', (input, expected) => {
      expect(normalize({ artist: input, title: 'x' }).normArtist).toBe(expected);
    });

    it('sorts the artist list alphabetically so order is canonical', () => {
      expect(normalize({ artist: 'Zomby, Burial', title: 'Test' }).normArtist).toBe(
        'burial & zomby',
      );
    });
  });

  describe('filename noise stripping', () => {
    it('strips a file extension', () => {
      expect(normalize({ artist: 'A', title: 'Glue.mp3' }).normTitle).toBe('glue');
    });

    it('strips a leading track number', () => {
      expect(normalize({ artist: 'A', title: '01 - Glue' }).normTitle).toBe('glue');
    });

    it('does NOT strip a leading year that is the whole title', () => {
      expect(normalize({ artist: 'Prince', title: '1999' }).normTitle).toBe('1999');
    });

    it('strips a trailing catalog number', () => {
      expect(normalize({ artist: 'A', title: 'Glue [CAT001]' }).normTitle).toBe('glue');
    });
  });

  it('squeezes redundant whitespace', () => {
    expect(normalize({ artist: '  Bicep   ', title: 'Glue   Mix' }).normTitle).toBe('glue mix');
  });
});
