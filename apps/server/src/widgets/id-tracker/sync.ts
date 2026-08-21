import type Database from 'better-sqlite3';
import { ID_TRACKER_SYNC_JOB, isSentinelTitle, type SyncSummary } from '@dashboard/shared';
import type { CronLogger, CronRegistry } from '../../cron';
import { recordRun } from '../../lib/job-runs';
import { fetchDurations, fetchPlaylistItems, readConfig, type PlaylistItem, type YouTubeConfig } from './youtube';

/**
 * Playlist sync — additive and non-destructive.
 *
 * The rules here are the widget's most important code, because every one of them prevents a
 * silent, unrecoverable loss:
 *
 *  1. New video → create a mix.
 *  2. Retitled → update `youtube_title` only. The display title is Steve's and never moves on its
 *     own; the difference surfaces as a pending rename he accepts or rejects.
 *  3. Sentinel title (`Deleted video` / `Private video`) → mark `unavailable`, keep the stored
 *     title. Adopting the sentinel would destroy the only record of what the mix is.
 *  4. Gone from the playlist → `in_playlist = 0`. Never deleted; the cues are the work.
 *  5. A playlist that errored marks NO removals — a partial fetch must not look like a purge.
 *  6. An archived mix stays archived, or archiving a mix still in a playlist would undo itself.
 */

export const ID_TRACKER_SYNC_SCHEDULE = process.env.ID_TRACKER_SYNC_SCHEDULE ?? '0 */12 * * *';

/** How stale a render tolerates before kicking off a background refresh. */
export const SYNC_TTL_MS = 15 * 60 * 1000;

/**
 * Only one sync at a time, process-wide.
 *
 * The render path fires this, and a widget registers as both an embedded card and a full page —
 * so two mounts a few hundred milliseconds apart would otherwise both start a sync and race each
 * other's writes.
 */
let inFlight: Promise<SyncSummary> | null = null;

export function syncInFlight(): boolean {
  return inFlight !== null;
}

export async function syncPlaylists(
  db: Database.Database,
  log: CronLogger,
  config: YouTubeConfig | null = readConfig(),
): Promise<SyncSummary> {
  if (inFlight) return inFlight;

  const run = (async () => {
    if (!config) {
      log.info('id-tracker: YOUTUBE_API_KEY / YOUTUBE_PLAYLIST_IDS unset — playlist sync skipped');
      return emptySummary();
    }
    return recordRun(db, ID_TRACKER_SYNC_JOB, async (ctx) => {
      const summary = await reconcileAll(db, config, log);
      ctx.setSummary(summary);
      if (summary.playlistsFailed > 0) {
        ctx.setOutcome(
          summary.playlistsFailed === summary.playlists ? 'error' : 'partial',
          `${summary.playlistsFailed} of ${summary.playlists} playlists could not be read`,
        );
      }
      return summary;
    });
  })();

  inFlight = run;
  try {
    return await run;
  } finally {
    inFlight = null;
  }
}

/** Refresh in the background if the data is stale. Never awaited by a render. */
export function maybeSyncInBackground(db: Database.Database, log: CronLogger): void {
  if (inFlight || !readConfig()) return;

  const row = db
    .prepare(`SELECT MAX(playlist_synced_at) AS last FROM id_tracker_mixes`)
    .get() as { last: number | null };

  if (row.last !== null && Date.now() - row.last < SYNC_TTL_MS) return;

  void syncPlaylists(db, log).catch((e: unknown) => {
    log.error(`id-tracker: background sync failed: ${e instanceof Error ? e.message : String(e)}`);
  });
}

function emptySummary(): SyncSummary {
  return { playlists: 0, created: 0, retitled: 0, removed: 0, unavailable: 0, playlistsFailed: 0 };
}

async function reconcileAll(
  db: Database.Database,
  config: YouTubeConfig,
  log: CronLogger,
): Promise<SyncSummary> {
  const summary = emptySummary();
  summary.playlists = config.playlistIds.length;
  const now = Date.now();

  for (const playlistId of config.playlistIds) {
    let items: PlaylistItem[];
    try {
      items = await fetchPlaylistItems(config, playlistId);
    } catch (e) {
      // Rule 5: this playlist contributes nothing this run — no creates, and crucially no
      // removals, so a transient failure cannot mass-flag every mix as gone.
      summary.playlistsFailed++;
      log.error(
        `id-tracker: playlist ${playlistId} could not be read: ${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }

    // Durations are a nicety (they enable the past-the-end timestamp check), so a failure here
    // must not fail the playlist that was read successfully.
    let durations = new Map<string, number>();
    try {
      durations = await fetchDurations(config, items.map((i) => i.videoId));
    } catch (e) {
      log.error(
        `id-tracker: durations for ${playlistId} unavailable: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    reconcilePlaylist(db, playlistId, items, durations, now, summary);
  }

  return summary;
}

interface ExistingRow {
  id: number;
  title: string;
  youtube_title: string | null;
  unavailable: number;
  in_playlist: number;
}

export function reconcilePlaylist(
  db: Database.Database,
  playlistId: string,
  items: PlaylistItem[],
  durations: Map<string, number>,
  now: number,
  summary: SyncSummary,
): void {
  const seen = new Set<string>();

  const apply = db.transaction(() => {
    for (const item of items) {
      const urlKey = `youtube:${item.videoId}`;
      seen.add(urlKey);

      const existing = db
        .prepare(
          `SELECT id, title, youtube_title, unavailable, in_playlist FROM id_tracker_mixes WHERE url_key = ?`,
        )
        .get(urlKey) as ExistingRow | undefined;

      const sentinel = isSentinelTitle(item.title);
      const duration = durations.get(item.videoId) ?? null;

      if (!existing) {
        // A brand-new mix whose video is already gone has no better name available, so the
        // sentinel is all there is to seed the title with — but it is still marked unavailable.
        db.prepare(
          `INSERT INTO id_tracker_mixes
             (url_key, url, source, title, youtube_title, youtube_video_id, playlist_id,
              duration_s, in_playlist, unavailable, added_to_playlist_at, playlist_synced_at, created_at)
           VALUES (?, ?, 'youtube', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        ).run(
          urlKey,
          `https://youtu.be/${item.videoId}`,
          item.title || 'Untitled mix',
          item.title,
          item.videoId,
          playlistId,
          duration,
          sentinel ? 1 : 0,
          item.addedToPlaylistAt,
          now,
          now,
        );
        summary.created++;
        if (sentinel) summary.unavailable++;
        continue;
      }

      if (sentinel) {
        // Rule 3. Keep the stored title; `pendingRename` refuses sentinels, so this can never
        // become a rename prompt either.
        if (existing.unavailable !== 1) summary.unavailable++;
        db.prepare(
          `UPDATE id_tracker_mixes
              SET unavailable = 1, in_playlist = 1, playlist_id = ?, playlist_synced_at = ?,
                  added_to_playlist_at = ?
            WHERE id = ?`,
        ).run(playlistId, now, item.addedToPlaylistAt, existing.id);
        continue;
      }

      if (item.title && item.title !== existing.youtube_title && item.title !== existing.title) {
        summary.retitled++;
      }

      db.prepare(
        `UPDATE id_tracker_mixes
            SET youtube_title = ?, youtube_video_id = ?, playlist_id = ?, duration_s = COALESCE(?, duration_s),
                in_playlist = 1, unavailable = 0, added_to_playlist_at = ?, playlist_synced_at = ?
          WHERE id = ?`,
      ).run(item.title, item.videoId, playlistId, duration, item.addedToPlaylistAt, now, existing.id);
    }

    // Rule 4: everything this playlist used to hold and no longer does. Scoped to THIS playlist's
    // mixes, so a mix belonging to another configured playlist is never touched here.
    const previously = db
      .prepare(`SELECT id, url_key FROM id_tracker_mixes WHERE playlist_id = ? AND in_playlist = 1`)
      .all(playlistId) as { id: number; url_key: string }[];

    for (const row of previously) {
      if (seen.has(row.url_key)) continue;
      db.prepare(`UPDATE id_tracker_mixes SET in_playlist = 0 WHERE id = ?`).run(row.id);
      summary.removed++;
    }
  });

  apply();
}

export function registerIdTrackerJobs(cron: CronRegistry, log: CronLogger, db: Database.Database): void {
  cron.register(ID_TRACKER_SYNC_JOB, ID_TRACKER_SYNC_SCHEDULE, async () => {
    await syncPlaylists(db, log);
  });
}
