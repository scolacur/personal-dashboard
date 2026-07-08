import type Database from 'better-sqlite3';
import type { CreateManualTrackInput, Track, TrackStatus } from '@dashboard/shared';
import { normalize } from './normalize';

type TrackRow = {
  id: number;
  source: string;
  raw_artist: string;
  raw_title: string;
  raw_remixer: string | null;
  raw_notes: string | null;
  entry_type: string | null;
  status: string;
  want_music_library: number;
  want_dj_library: number;
  detected_at: number;
};

function rowToTrack(row: TrackRow): Track {
  return {
    id: row.id,
    source: row.source,
    rawArtist: row.raw_artist,
    rawTitle: row.raw_title,
    rawRemixer: row.raw_remixer,
    rawNotes: row.raw_notes,
    entryType: row.entry_type ?? 'song',
    status: row.status as TrackStatus,
    wantMusicLibrary: row.want_music_library === 1,
    wantDjLibrary: row.want_dj_library === 1,
    detectedAt: row.detected_at,
  };
}

const SELECT =
  'SELECT id, source, raw_artist, raw_title, raw_remixer, raw_notes, entry_type, status, want_music_library, want_dj_library, detected_at FROM music_tracker_tracks';

export function listTracks(db: Database.Database): Track[] {
  const rows = db.prepare(`${SELECT} ORDER BY detected_at DESC, id DESC`).all() as TrackRow[];
  return rows.map(rowToTrack);
}

export function getTrack(db: Database.Database, id: number): Track | null {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as TrackRow | undefined;
  return row ? rowToTrack(row) : null;
}

/** Insert a manually-entered track. source is 'manual', source_ref stays NULL. */
export function insertManualTrack(db: Database.Database, input: CreateManualTrackInput): Track {
  const artist = input.artist.trim();
  const title = input.title.trim();
  const remixer = input.remixer?.trim() || null;
  const notes = input.notes?.trim() || null;
  const norm = normalize({ artist, title });

  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO music_tracker_tracks
         (source, raw_artist, raw_title, raw_remixer, raw_notes, entry_type,
          norm_artist, norm_title, norm_remixer, status,
          want_music_library, want_dj_library, detected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'manual',
      artist,
      title,
      remixer,
      notes,
      'song',
      norm.normArtist,
      norm.normTitle,
      norm.normRemixer,
      'new',
      input.wantMusicLibrary ? 1 : 0,
      input.wantDjLibrary ? 1 : 0,
      Date.now(),
    );

  return getTrack(db, Number(lastInsertRowid))!;
}
