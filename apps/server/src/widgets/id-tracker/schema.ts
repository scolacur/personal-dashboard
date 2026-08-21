import type Database from 'better-sqlite3';

/**
 * ID Tracker schema (see `widgets/id-tracker/PROJECT.md` §2).
 *
 * There is deliberately no `id_tracker_runs` table: sync runs are recorded through the shared
 * job-run store (`lib/job-runs.ts`, PD-442 / D-074) under `id-tracker:playlist-sync`. Music
 * Tracker's own runs table predates that store.
 */
export function bootstrapSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS id_tracker_mixes (
      id                   INTEGER PRIMARY KEY,
      url_key              TEXT    NOT NULL UNIQUE,
      url                  TEXT,
      source               TEXT    NOT NULL DEFAULT 'manual',
      title                TEXT    NOT NULL,
      youtube_title        TEXT,
      dismissed_title      TEXT,
      youtube_video_id     TEXT,
      playlist_id          TEXT,
      duration_s           INTEGER,
      in_playlist          INTEGER NOT NULL DEFAULT 1,
      unavailable          INTEGER NOT NULL DEFAULT 0,
      archived_at          INTEGER,
      added_to_playlist_at INTEGER,
      playlist_synced_at   INTEGER,
      created_at           INTEGER NOT NULL
    );

    /* The list is always "active mixes, most recently added to the playlist first" — the mix
       just added is the one being worked on. */
    CREATE INDEX IF NOT EXISTS idx_id_tracker_mixes_added
      ON id_tracker_mixes (archived_at, added_to_playlist_at DESC);

    CREATE TABLE IF NOT EXISTS id_tracker_cues (
      id             INTEGER PRIMARY KEY,
      mix_id         INTEGER NOT NULL REFERENCES id_tracker_mixes(id) ON DELETE CASCADE,
      position_s     INTEGER NOT NULL,
      end_position_s INTEGER,
      artist         TEXT,
      title          TEXT,
      remixer        TEXT,
      notes          TEXT,
      identified     INTEGER NOT NULL DEFAULT 0,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );

    /* Cues are always read per-mix in playback order. */
    CREATE INDEX IF NOT EXISTS idx_id_tracker_cues_mix
      ON id_tracker_cues (mix_id, position_s);
  `);
}
