import type Database from 'better-sqlite3';
import {
  formatPosition,
  isIdentified,
  mixUrlKey,
  parsePosition,
  parseYouTubeUrl,
  pendingRename,
  type CreateCueInput,
  type CreateMixInput,
  type Cue,
  type Mix,
  type UpdateCueInput,
} from '@dashboard/shared';

/**
 * ID Tracker store. All SQL lives here — route handlers stay free of it (PROJECT.md §5).
 *
 * Two invariants this module owns, because both are the kind of thing that goes wrong silently
 * if any caller is allowed to set them by hand:
 *
 *  - `identified` is **derived** on every cue write from artist + title.
 *  - a mix's identity is its **url_key**, computed from the URL (or the title, when there is no
 *    URL). Nothing else may key a mix.
 */

interface MixRow {
  id: number;
  url_key: string;
  url: string | null;
  source: string;
  title: string;
  youtube_title: string | null;
  dismissed_title: string | null;
  youtube_video_id: string | null;
  playlist_id: string | null;
  duration_s: number | null;
  in_playlist: number;
  unavailable: number;
  archived_at: number | null;
  added_to_playlist_at: number | null;
  playlist_synced_at: number | null;
  created_at: number;
}

interface CueRow {
  id: number;
  mix_id: number;
  position_s: number;
  end_position_s: number | null;
  artist: string | null;
  title: string | null;
  remixer: string | null;
  notes: string | null;
  identified: number;
  created_at: number;
  updated_at: number;
}

function rowToCue(r: CueRow): Cue {
  return {
    id: r.id,
    mixId: r.mix_id,
    positionS: r.position_s,
    endPositionS: r.end_position_s,
    artist: r.artist,
    title: r.title,
    remixer: r.remixer,
    notes: r.notes,
    identified: r.identified === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToMix(r: MixRow, cues: Cue[]): Mix {
  return {
    id: r.id,
    urlKey: r.url_key,
    url: r.url,
    source: r.source === 'youtube' ? 'youtube' : 'manual',
    title: r.title,
    youtubeTitle: r.youtube_title,
    dismissedTitle: r.dismissed_title,
    youtubeVideoId: r.youtube_video_id,
    playlistId: r.playlist_id,
    durationS: r.duration_s,
    inPlaylist: r.in_playlist === 1,
    unavailable: r.unavailable === 1,
    archivedAt: r.archived_at,
    addedToPlaylistAt: r.added_to_playlist_at,
    playlistSyncedAt: r.playlist_synced_at,
    createdAt: r.created_at,
    cues,
    pendingRename: pendingRename({
      title: r.title,
      youtubeTitle: r.youtube_title,
      dismissedTitle: r.dismissed_title,
    }),
  };
}

/** Thrown for input the caller got wrong; routes turn it into a 400. */
export class ValidationError extends Error {}

/** A mix already exists on this url_key. Carries the existing mix so the UI can offer
 *  "restore it?" rather than a dead end — the archived case is the one that would otherwise
 *  read as an inexplicable failure. */
export class DuplicateMixError extends Error {
  constructor(readonly existing: Mix) {
    super('A mix with this URL is already tracked.');
  }
}

/**
 * Mixes, newest-added-to-the-playlist first.
 *
 * Cues are fetched in one query and grouped in memory rather than per-mix: the page renders every
 * mix with its cues nested, and this widget's whole dataset is small enough that one extra query
 * beats N.
 */
export function listMixes(db: Database.Database, opts: { includeArchived?: boolean } = {}): Mix[] {
  const rows = db
    .prepare(
      `SELECT * FROM id_tracker_mixes
        ${opts.includeArchived ? '' : 'WHERE archived_at IS NULL'}
        ORDER BY COALESCE(added_to_playlist_at, created_at) DESC, id DESC`,
    )
    .all() as MixRow[];

  const cueRows = db
    .prepare(`SELECT * FROM id_tracker_cues ORDER BY position_s ASC, id ASC`)
    .all() as CueRow[];

  const byMix = new Map<number, Cue[]>();
  for (const c of cueRows) {
    const list = byMix.get(c.mix_id) ?? [];
    list.push(rowToCue(c));
    byMix.set(c.mix_id, list);
  }

  return rows.map((r) => rowToMix(r, byMix.get(r.id) ?? []));
}

export function getMix(db: Database.Database, id: number): Mix | null {
  const row = db.prepare(`SELECT * FROM id_tracker_mixes WHERE id = ?`).get(id) as MixRow | undefined;
  if (!row) return null;
  const cues = db
    .prepare(`SELECT * FROM id_tracker_cues WHERE mix_id = ? ORDER BY position_s ASC, id ASC`)
    .all(id) as CueRow[];
  return rowToMix(row, cues.map(rowToCue));
}

function getMixByUrlKey(db: Database.Database, urlKey: string): Mix | null {
  const row = db.prepare(`SELECT id FROM id_tracker_mixes WHERE url_key = ?`).get(urlKey) as
    | { id: number }
    | undefined;
  return row ? getMix(db, row.id) : null;
}

/**
 * Create a mix by hand. Non-YouTube mixes and URL-less mixes are first-class here — that is the
 * whole point of keying on `url_key` rather than on a video id.
 */
export function createMix(db: Database.Database, input: CreateMixInput): Mix {
  const title = input.title?.trim();
  if (!title) throw new ValidationError('A mix needs a name.');

  const url = input.url?.trim() || null;
  const urlKey = mixUrlKey({ url, title });

  const existing = getMixByUrlKey(db, urlKey);
  if (existing) throw new DuplicateMixError(existing);

  const yt = url ? parseYouTubeUrl(url) : null;
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO id_tracker_mixes (url_key, url, source, title, youtube_video_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(urlKey, url, yt ? 'youtube' : 'manual', title, yt?.videoId ?? null, now);

  return getMix(db, Number(info.lastInsertRowid))!;
}

/** Rename by hand. The display title is Steve's; nothing else may move it. */
export function renameMix(db: Database.Database, id: number, title: string): Mix {
  const t = title.trim();
  if (!t) throw new ValidationError('A mix needs a name.');
  const mix = getMix(db, id);
  if (!mix) throw new ValidationError('No such mix.');

  // A URL-less mix is keyed off its title, so renaming it moves its identity. Re-key rather
  // than leaving a stale slug that would no longer match a later create of the same name.
  const nextKey = mix.url ? mix.urlKey : mixUrlKey({ title: t });
  if (nextKey !== mix.urlKey) {
    const clash = getMixByUrlKey(db, nextKey);
    if (clash) throw new DuplicateMixError(clash);
  }

  db.prepare(`UPDATE id_tracker_mixes SET title = ?, url_key = ? WHERE id = ?`).run(t, nextKey, id);
  return getMix(db, id)!;
}

/** Adopt YouTube's title. */
export function acceptRename(db: Database.Database, id: number): Mix {
  const mix = getMix(db, id);
  if (!mix) throw new ValidationError('No such mix.');
  if (!mix.pendingRename) return mix;
  db.prepare(`UPDATE id_tracker_mixes SET title = ? WHERE id = ?`).run(mix.pendingRename, id);
  return getMix(db, id)!;
}

/** Keep our title and stop being asked about *this* one. A later, different retitle raises again. */
export function rejectRename(db: Database.Database, id: number): Mix {
  const mix = getMix(db, id);
  if (!mix) throw new ValidationError('No such mix.');
  if (!mix.pendingRename) return mix;
  db.prepare(`UPDATE id_tracker_mixes SET dismissed_title = ? WHERE id = ?`).run(mix.pendingRename, id);
  return getMix(db, id)!;
}

/**
 * Archive is the only removal concept — there is no delete. A mix's cues are hand-typed work and
 * no button destroys them. Sync never clears `archived_at`, so archiving a mix still in a
 * playlist sticks.
 */
export function archiveMix(db: Database.Database, id: number): Mix {
  db.prepare(`UPDATE id_tracker_mixes SET archived_at = ? WHERE id = ? AND archived_at IS NULL`).run(
    Date.now(),
    id,
  );
  const mix = getMix(db, id);
  if (!mix) throw new ValidationError('No such mix.');
  return mix;
}

export function restoreMix(db: Database.Database, id: number): Mix {
  db.prepare(`UPDATE id_tracker_mixes SET archived_at = NULL WHERE id = ?`).run(id);
  const mix = getMix(db, id);
  if (!mix) throw new ValidationError('No such mix.');
  return mix;
}

export interface CueWrite {
  cue: Cue;
  /** Non-fatal notes about what was just written — currently only the duplicate-position case,
   *  which is allowed because a layered blend is real, but is usually double-logging. */
  warnings: string[];
}

function resolvePosition(raw: string, label: string): number {
  const parsed = parsePosition(raw);
  if (!parsed.ok) throw new ValidationError(`${label}: ${parsed.error}`);
  return parsed.seconds;
}

function text(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

export function createCue(db: Database.Database, input: CreateCueInput): CueWrite {
  const mix = getMix(db, input.mixId);
  if (!mix) throw new ValidationError('No such mix.');

  const positionS = resolvePosition(input.position, 'Timestamp');
  const endPositionS = input.endPosition ? resolvePosition(input.endPosition, 'End timestamp') : null;

  const warnings = validatePosition(mix, positionS, endPositionS, null);

  const artist = text(input.artist);
  const title = text(input.title);
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO id_tracker_cues
         (mix_id, position_s, end_position_s, artist, title, remixer, notes, identified, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      mix.id,
      positionS,
      endPositionS,
      artist,
      title,
      text(input.remixer),
      text(input.notes),
      isIdentified(artist, title) ? 1 : 0,
      now,
      now,
    );

  const cue = db.prepare(`SELECT * FROM id_tracker_cues WHERE id = ?`).get(Number(info.lastInsertRowid)) as CueRow;
  return { cue: rowToCue(cue), warnings };
}

export function updateCue(db: Database.Database, id: number, input: UpdateCueInput): CueWrite {
  const row = db.prepare(`SELECT * FROM id_tracker_cues WHERE id = ?`).get(id) as CueRow | undefined;
  if (!row) throw new ValidationError('No such ID.');
  const mix = getMix(db, row.mix_id)!;

  const positionS = input.position === undefined ? row.position_s : resolvePosition(input.position, 'Timestamp');
  const endPositionS =
    input.endPosition === undefined
      ? row.end_position_s
      : input.endPosition
        ? resolvePosition(input.endPosition, 'End timestamp')
        : null;

  const warnings = validatePosition(mix, positionS, endPositionS, id);

  const artist = input.artist === undefined ? row.artist : text(input.artist);
  const title = input.title === undefined ? row.title : text(input.title);
  const remixer = input.remixer === undefined ? row.remixer : text(input.remixer);
  const notes = input.notes === undefined ? row.notes : text(input.notes);

  db.prepare(
    `UPDATE id_tracker_cues
        SET position_s = ?, end_position_s = ?, artist = ?, title = ?, remixer = ?, notes = ?,
            identified = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    positionS,
    endPositionS,
    artist,
    title,
    remixer,
    notes,
    isIdentified(artist, title) ? 1 : 0,
    Date.now(),
    id,
  );

  const updated = db.prepare(`SELECT * FROM id_tracker_cues WHERE id = ?`).get(id) as CueRow;
  return { cue: rowToCue(updated), warnings };
}

export function deleteCue(db: Database.Database, id: number): void {
  db.prepare(`DELETE FROM id_tracker_cues WHERE id = ?`).run(id);
}

/**
 * Position rules, shared by create and update.
 *
 * Past the mix's duration is a hard error — 1:47:30 on a 62-minute mix is certainly a typo — but
 * only when the duration is actually known, which it is not for manual mixes or when the
 * `videos.list` call failed.
 *
 * An exact-duplicate position warns rather than refuses. Near-but-different positions are a
 * normal blend and say nothing at all.
 */
function validatePosition(
  mix: Mix,
  positionS: number,
  endPositionS: number | null,
  ignoreCueId: number | null,
): string[] {
  if (mix.durationS && positionS > mix.durationS) {
    throw new ValidationError(
      `That timestamp is past the end of the mix (${formatPosition(mix.durationS)}).`,
    );
  }
  if (endPositionS !== null && endPositionS <= positionS) {
    throw new ValidationError('The end timestamp has to come after the start.');
  }

  const clash = mix.cues.find((c) => c.positionS === positionS && c.id !== ignoreCueId);
  return clash ? [`There is already an ID at ${formatPosition(positionS)} on this mix.`] : [];
}
