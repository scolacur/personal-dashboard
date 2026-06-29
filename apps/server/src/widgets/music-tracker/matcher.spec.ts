import { describe, it, expect } from 'vitest';
import { normalize } from './normalize';
import { findMatches, shouldAutoConfirm } from './matcher';
import type { TrackInput, LibraryFileInput } from './matcher';

// ---------------------------------------------------------------------------
// Fixture library (migrated from the former matcher.fixture.ts)
// ---------------------------------------------------------------------------
const rawLibrary: Array<{ id: number; artist: string; title: string; duration_ms: number }> = [
  { id: 1, artist: 'Bicep', title: 'Glue', duration_ms: 327_000 },
  { id: 2, artist: 'Bicep', title: 'Glue (Maxxi Soundsystem Remix)', duration_ms: 380_000 },
  { id: 3, artist: 'Four Tet', title: 'Baby', duration_ms: 306_000 },
  { id: 4, artist: 'Burial', title: 'Archangel', duration_ms: 296_000 },
  { id: 5, artist: 'Burial', title: 'Archangel (Kosmik Edit)', duration_ms: 297_000 },
  { id: 6, artist: 'Bicep', title: 'Glue', duration_ms: 385_000 }, // extended
  { id: 7, artist: 'Totally Different Artist', title: 'Glue', duration_ms: 327_000 }, // same title, different artist
];

function toLibraryFile(row: (typeof rawLibrary)[number]): LibraryFileInput {
  const n = normalize({ artist: row.artist, title: row.title });
  return {
    id: row.id,
    norm_artist: n.normArtist,
    norm_title: n.normTitle,
    norm_remixer: n.normRemixer,
    duration_ms: row.duration_ms,
  };
}

function toTrack(artist: string, title: string, duration_ms: number | null): TrackInput {
  const n = normalize({ artist, title });
  return {
    id: 0,
    norm_artist: n.normArtist,
    norm_title: n.normTitle,
    norm_remixer: n.normRemixer,
    duration_ms,
  };
}

const library = rawLibrary.map(toLibraryFile);
const idsOf = (cs: { libraryFileId: number }[]) => cs.map((c) => c.libraryFileId);

describe('findMatches', () => {
  it('returns nothing for an empty library', () => {
    expect(findMatches(toTrack('Bicep', 'Glue', 327_000), [])).toEqual([]);
  });

  it('finds the exact original and auto-confirms', () => {
    const candidates = findMatches(toTrack('Bicep', 'Glue', 327_000), library);
    expect(idsOf(candidates)).toContain(1);
    expect(shouldAutoConfirm(candidates)).toBe(true);
  });

  it('surfaces the remix when querying the original title (no duration gate)', () => {
    const candidates = findMatches(toTrack('Bicep', 'Glue', 327_000), library);
    expect(idsOf(candidates)).toContain(2);
  });

  it('matches a remix query to the remix entry and auto-confirms', () => {
    const candidates = findMatches(
      toTrack('Bicep', 'Glue (Maxxi Soundsystem Remix)', 380_000),
      library,
    );
    expect(idsOf(candidates)).toContain(2);
    expect(shouldAutoConfirm(candidates)).toBe(true);
  });

  it('ignores duration: a short edit still surfaces both Glue entries', () => {
    const candidates = findMatches(toTrack('Bicep', 'Glue', 185_000), library);
    expect(idsOf(candidates)).toEqual(expect.arrayContaining([1, 6]));
  });

  it('returns no candidates for a track not in the library', () => {
    const candidates = findMatches(
      toTrack('Unknown Artist', 'Definitely Not In Library XYZ', 200_000),
      library,
    );
    expect(candidates).toEqual([]);
  });

  it('disambiguates by artist: correct Bicep Glue outscores the wrong-artist Glue', () => {
    const candidates = findMatches(toTrack('Bicep', 'Glue', 327_000), library);
    expect(candidates[0]?.libraryFileId).toBe(1);
    const wrongArtist = candidates.find((c) => c.libraryFileId === 7);
    if (wrongArtist) {
      expect(candidates[0].confidence).toBeGreaterThan(wrongArtist.confidence);
    }
  });

  it('only returns candidates at or above the minimum confidence, sorted descending', () => {
    const candidates = findMatches(toTrack('Bicep', 'Glue', 327_000), library);
    for (const c of candidates) {
      expect(c.confidence).toBeGreaterThanOrEqual(0.65);
    }
    const confidences = candidates.map((c) => c.confidence);
    expect(confidences).toEqual([...confidences].sort((a, b) => b - a));
  });
});

describe('shouldAutoConfirm', () => {
  it('is true when any candidate meets the auto-confirm threshold', () => {
    expect(shouldAutoConfirm([{ libraryFileId: 1, confidence: 0.9 }])).toBe(true);
  });

  it('is false when every candidate is below the threshold', () => {
    expect(shouldAutoConfirm([{ libraryFileId: 1, confidence: 0.7 }])).toBe(false);
  });

  it('is false for an empty candidate list', () => {
    expect(shouldAutoConfirm([])).toBe(false);
  });
});
