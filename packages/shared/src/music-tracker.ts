// Shared types for the Music Tracker widget.

export type TrackStatus = 'new' | 'in_library' | 'wanted' | 'acquired' | 'ignored';

export const TRACK_STATUSES: readonly TrackStatus[] = [
  'new',
  'in_library',
  'wanted',
  'acquired',
  'ignored',
];

/** A detected/tracked song, as returned to the frontend (camelCase row shape). */
export interface Track {
  id: number;
  source: string; // 'manual' | 'spotify' | ...
  rawArtist: string;
  rawTitle: string;
  rawRemixer: string | null;
  rawNotes: string | null;
  entryType: string; // 'song' | 'mix' | ... (default 'song')
  status: TrackStatus;
  wantMusicLibrary: boolean;
  wantDjLibrary: boolean;
  detectedAt: number; // unix ms
}

/** Payload for the manual "add a track" form. */
export interface CreateManualTrackInput {
  artist: string;
  title: string;
  remixer?: string;
  notes?: string;
  wantMusicLibrary?: boolean;
  wantDjLibrary?: boolean;
}
