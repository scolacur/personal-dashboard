import Fuse from 'fuse.js';

// Tuning constants — adjust after observing false positives/negatives on real data.
// See Widgets/Music Tracker/PROJECT.md §5 for design rationale.
export const MATCH_CONFIG = {
  minConfidence: 0.65,
  autoConfirmConfidence: 0.85,
  weights: {
    normTitle: 0.50,
    normArtist: 0.35,
    normRemixer: 0.15,
  },
  fuseOptions: {
    threshold: 1.0,      // no internal cutoff — we apply minConfidence ourselves
    ignoreLocation: true,
    distance: 200,
    minMatchCharLength: 2,
  },
} as const;

export interface TrackInput {
  id: number;
  norm_artist: string;
  norm_title: string;
  norm_remixer: string | null;
  duration_ms: number | null;
}

export interface LibraryFileInput {
  id: number;
  norm_artist: string | null;
  norm_title: string | null;
  norm_remixer: string | null;
  duration_ms: number | null;
}

export interface MatchCandidate {
  libraryFileId: number;
  confidence: number;
}

type ScoreMap = Map<number, number>;

// Score each library item against a single field query using Fuse.js.
function buildFieldScores(
  library: LibraryFileInput[],
  field: keyof LibraryFileInput,
  query: string,
): ScoreMap {
  const fuse = new Fuse(library, {
    keys: [field as string],
    includeScore: true,
    ...MATCH_CONFIG.fuseOptions,
  });
  const map: ScoreMap = new Map();
  fuse.search(query).forEach((r) => map.set(r.item.id, 1 - (r.score ?? 1)));
  return map;
}

export function findMatches(track: TrackInput, library: LibraryFileInput[]): MatchCandidate[] {
  if (!library.length) return [];

  const { normTitle: wT, normArtist: wA, normRemixer: wR } = MATCH_CONFIG.weights;

  // Score each field independently so "bicep" is only compared against artist fields,
  // "glue" only against title fields, etc.
  const titleScores = buildFieldScores(library, 'norm_title', track.norm_title);
  const artistScores = track.norm_artist
    ? buildFieldScores(library, 'norm_artist', track.norm_artist)
    : null;
  const remixerScores = track.norm_remixer
    ? buildFieldScores(library, 'norm_remixer', track.norm_remixer)
    : null;

  return library
    .map((f) => {
      // Only include a field's weight when both sides have a value for it.
      // Missing fields don't penalise the score — weight is redistributed proportionally.
      let score = 0;
      let weight = 0;

      score += (titleScores.get(f.id) ?? 0) * wT;
      weight += wT;

      if (artistScores && f.norm_artist) {
        score += (artistScores.get(f.id) ?? 0) * wA;
        weight += wA;
      }

      if (remixerScores && f.norm_remixer) {
        score += (remixerScores.get(f.id) ?? 0) * wR;
        weight += wR;
      }

      const confidence = weight > 0 ? parseFloat((score / weight).toFixed(4)) : 0;
      return { libraryFileId: f.id, confidence };
    })
    .filter((c) => c.confidence >= MATCH_CONFIG.minConfidence)
    .sort((a, b) => b.confidence - a.confidence);
}

export function shouldAutoConfirm(candidates: MatchCandidate[]): boolean {
  return candidates.some((c) => c.confidence >= MATCH_CONFIG.autoConfirmConfidence);
}
