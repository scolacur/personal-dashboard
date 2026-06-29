import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import type Database from 'better-sqlite3';
import { normalize } from './normalize';

const AUDIO_EXT = new Set(['.mp3', '.flac', '.aif', '.aiff', '.wav', '.m4a', '.ogg', '.opus']);

export interface ScanResult {
  added: number;
  updated: number;
  skipped: number;
}

export async function scanLibrary(db: Database.Database, libraryPath: string): Promise<ScanResult> {
  const upsert = db.prepare(`
    INSERT INTO music_tracker_library_files
      (path, size, mtime, raw_artist, raw_title, raw_remixer, raw_album, duration_ms,
       norm_artist, norm_title, norm_remixer, indexed_at)
    VALUES
      (@path, @size, @mtime, @raw_artist, @raw_title, @raw_remixer, @raw_album, @duration_ms,
       @norm_artist, @norm_title, @norm_remixer, @indexed_at)
    ON CONFLICT(path) DO UPDATE SET
      size        = excluded.size,
      mtime       = excluded.mtime,
      raw_artist  = excluded.raw_artist,
      raw_title   = excluded.raw_title,
      raw_remixer = excluded.raw_remixer,
      raw_album   = excluded.raw_album,
      duration_ms = excluded.duration_ms,
      norm_artist = excluded.norm_artist,
      norm_title  = excluded.norm_title,
      norm_remixer = excluded.norm_remixer,
      indexed_at  = excluded.indexed_at
  `);

  const getExisting = db.prepare<[string], { mtime: number; size: number }>(
    'SELECT mtime, size FROM music_tracker_library_files WHERE path = ?'
  );

  const result: ScanResult = { added: 0, updated: 0, skipped: 0 };

  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (!AUDIO_EXT.has(path.extname(entry).toLowerCase())) continue;

      const mtime = stat.mtimeMs;
      const size = stat.size;
      const existing = getExisting.get(fullPath);

      if (existing && existing.mtime === mtime && existing.size === size) {
        result.skipped++;
        continue;
      }

      let rawArtist: string | null = null;
      let rawTitle: string | null = null;
      let rawAlbum: string | null = null;
      let durationMs: number | null = null;

      try {
        const meta = await parseFile(fullPath, { duration: true });
        rawArtist = meta.common.artist ?? null;
        rawTitle = meta.common.title ?? null;
        rawAlbum = meta.common.album ?? null;
        durationMs = meta.format.duration != null
          ? Math.round(meta.format.duration * 1000)
          : null;
      } catch {
        // Fall back to filename if tags are unreadable
        rawTitle = path.basename(entry, path.extname(entry));
      }

      const normed = normalize({
        artist: rawArtist ?? '',
        title: rawTitle ?? path.basename(entry, path.extname(entry)),
      });

      upsert.run({
        path: fullPath,
        size,
        mtime,
        raw_artist: rawArtist,
        raw_title: rawTitle,
        raw_remixer: null,
        raw_album: rawAlbum,
        duration_ms: durationMs,
        norm_artist: normed.normArtist || null,
        norm_title: normed.normTitle || null,
        norm_remixer: normed.normRemixer,
        indexed_at: Date.now(),
      });

      if (existing) {
        result.updated++;
      } else {
        result.added++;
      }
    }
  }

  await walk(libraryPath);
  return result;
}
