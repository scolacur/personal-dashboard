import type Database from 'better-sqlite3';

export function bootstrapSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS music_tracker_tracks (
      id          INTEGER PRIMARY KEY,
      source      TEXT    NOT NULL,
      source_ref  TEXT,
      source_context TEXT,
      raw_artist  TEXT    NOT NULL,
      raw_title   TEXT    NOT NULL,
      raw_remixer TEXT,
      raw_album   TEXT,
      raw_year    INTEGER,
      raw_notes   TEXT,
      entry_type  TEXT,
      duration_ms INTEGER,
      norm_artist TEXT    NOT NULL,
      norm_title  TEXT    NOT NULL,
      norm_remixer TEXT,
      status      TEXT    NOT NULL DEFAULT 'new',
      want_music_library INTEGER NOT NULL DEFAULT 0,
      want_dj_library    INTEGER NOT NULL DEFAULT 0,
      detected_at INTEGER NOT NULL,
      reviewed_at INTEGER,
      UNIQUE(source, source_ref)
    );

    CREATE TABLE IF NOT EXISTS music_tracker_library_files (
      id          INTEGER PRIMARY KEY,
      path        TEXT    NOT NULL UNIQUE,
      size        INTEGER NOT NULL,
      mtime       INTEGER NOT NULL,
      raw_artist  TEXT,
      raw_title   TEXT,
      raw_remixer TEXT,
      raw_album   TEXT,
      duration_ms INTEGER,
      norm_artist TEXT,
      norm_title  TEXT,
      norm_remixer TEXT,
      indexed_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS music_tracker_matches (
      id              INTEGER PRIMARY KEY,
      track_id        INTEGER NOT NULL REFERENCES music_tracker_tracks(id) ON DELETE CASCADE,
      library_file_id INTEGER NOT NULL REFERENCES music_tracker_library_files(id) ON DELETE CASCADE,
      score           REAL    NOT NULL,
      is_confirmed    INTEGER NOT NULL DEFAULT 0,
      UNIQUE(track_id, library_file_id)
    );

    CREATE TABLE IF NOT EXISTS music_tracker_runs (
      id          INTEGER PRIMARY KEY,
      started_at  INTEGER NOT NULL,
      finished_at INTEGER,
      job         TEXT    NOT NULL,
      trigger     TEXT    NOT NULL,
      ok          INTEGER,
      summary     TEXT,
      error       TEXT
    );
  `);

  // Idempotent migrations for tables that predate later columns.
  // CREATE TABLE IF NOT EXISTS above is a no-op on an existing table, so new
  // columns must be added explicitly for DBs created before this widget grew them.
  addColumnIfMissing(db, 'music_tracker_tracks', 'want_music_library', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'music_tracker_tracks', 'want_dj_library', 'INTEGER NOT NULL DEFAULT 0');
}

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
