/**
 * Hand-rolled fixture for the matcher — run with `npm run test:matcher -w apps/server`.
 * No test framework; plain assertions + exit code.
 */
import { normalize } from './normalize';
import { findMatches, shouldAutoConfirm } from './matcher';
import type { TrackInput, LibraryFileInput } from './matcher';

// ---------------------------------------------------------------------------
// Fixture library
// ---------------------------------------------------------------------------
const rawLibrary: Array<{ id: number; artist: string; title: string; duration_ms: number }> = [
  { id: 1, artist: 'Bicep',                    title: 'Glue',                            duration_ms: 327_000 },
  { id: 2, artist: 'Bicep',                    title: 'Glue (Maxxi Soundsystem Remix)',   duration_ms: 380_000 },
  { id: 3, artist: 'Four Tet',                 title: 'Baby',                            duration_ms: 306_000 },
  { id: 4, artist: 'Burial',                   title: 'Archangel',                       duration_ms: 296_000 },
  { id: 5, artist: 'Burial',                   title: 'Archangel (Kosmik Edit)',          duration_ms: 297_000 },
  { id: 6, artist: 'Bicep',                    title: 'Glue',                            duration_ms: 385_000 }, // extended
  { id: 7, artist: 'Totally Different Artist', title: 'Glue',                            duration_ms: 327_000 }, // same title, different artist
];

function toLibraryFile(row: (typeof rawLibrary)[number]): LibraryFileInput {
  const n = normalize({ artist: row.artist, title: row.title });
  return { id: row.id, norm_artist: n.normArtist, norm_title: n.normTitle, norm_remixer: n.normRemixer, duration_ms: row.duration_ms };
}

function toTrack(artist: string, title: string, duration_ms: number | null): TrackInput {
  const n = normalize({ artist, title });
  return { id: 0, norm_artist: n.normArtist, norm_title: n.normTitle, norm_remixer: n.normRemixer, duration_ms };
}

const library = rawLibrary.map(toLibraryFile);

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------
type Case = {
  label: string;
  track: TrackInput;
  expectIds: number[];       // IDs that MUST appear in results
  rejectIds?: number[];      // IDs that must NOT appear
  expectAutoConfirm?: boolean;
};

const cases: Case[] = [
  {
    label: 'Exact match: Bicep – Glue (original)',
    track: toTrack('Bicep', 'Glue', 327_000),
    expectIds: [1],
    expectAutoConfirm: true,
  },
  {
    label: 'Finds remix when querying original title',
    track: toTrack('Bicep', 'Glue', 327_000),
    expectIds: [2], // no duration gate — extended remix still surfaces
  },
  {
    label: 'Remix query matches remix',
    track: toTrack('Bicep', 'Glue (Maxxi Soundsystem Remix)', 380_000),
    expectIds: [2],
    expectAutoConfirm: true,
  },
  {
    label: 'No duration gate: extended version found when searching for short edit',
    track: toTrack('Bicep', 'Glue', 185_000), // fictional short radio edit
    expectIds: [1, 6],                          // both Glue entries should surface
  },
  {
    label: 'No match: track not in library',
    track: toTrack('Unknown Artist', 'Definitely Not In Library XYZ', 200_000),
    expectIds: [],
  },
  {
    label: 'Artist disambiguation: wrong-artist Glue scores lower than correct Bicep Glue',
    track: toTrack('Bicep', 'Glue', 327_000),
    expectIds: [1],
    rejectIds: [], // id:7 may still appear but should score lower than id:1 — checked below
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

for (const tc of cases) {
  const candidates = findMatches(tc.track, library);
  const ids = new Set(candidates.map((c) => c.libraryFileId));
  const top = candidates[0];

  const missingIds = tc.expectIds.filter((id) => !ids.has(id));
  const forbiddenIds = (tc.rejectIds ?? []).filter((id) => ids.has(id));

  const ok = missingIds.length === 0 && forbiddenIds.length === 0 &&
    (tc.expectAutoConfirm === undefined || shouldAutoConfirm(candidates) === tc.expectAutoConfirm);

  const mark = ok ? '✓' : '✗';
  console.log(`${mark} ${tc.label}`);
  candidates.forEach((c) =>
    console.log(`    id:${c.libraryFileId}  confidence:${c.confidence}`)
  );
  if (!candidates.length) console.log('    (no candidates)');

  if (!ok) {
    if (missingIds.length) console.log(`  ✗ expected ids missing: [${missingIds}]`);
    if (forbiddenIds.length) console.log(`  ✗ forbidden ids present: [${forbiddenIds}]`);
    if (tc.expectAutoConfirm !== undefined && shouldAutoConfirm(candidates) !== tc.expectAutoConfirm)
      console.log(`  ✗ autoConfirm: expected ${tc.expectAutoConfirm}, got ${shouldAutoConfirm(candidates)}`);
    failed++;
  } else {
    passed++;
  }

  // Extra check: for the artist-disambiguation case, Bicep Glue should outscore wrong-artist Glue
  if (tc.label.startsWith('Artist disambiguation') && top) {
    const wrongArtist = candidates.find((c) => c.libraryFileId === 7);
    if (wrongArtist && top.libraryFileId === 1 && top.confidence > wrongArtist.confidence) {
      console.log(`    ✓ Bicep Glue (${top.confidence}) outscores wrong-artist Glue (${wrongArtist.confidence})`);
    } else if (wrongArtist) {
      console.log(`    ✗ Expected id:1 to outscore id:7, got top=${top.libraryFileId}`);
    }
  }

  console.log();
}

console.log(`${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
