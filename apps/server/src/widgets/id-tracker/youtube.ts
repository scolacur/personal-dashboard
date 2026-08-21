/**
 * YouTube Data API v3 client — read-only, API-key auth.
 *
 * The playlists are public, so an API key is enough and no OAuth dance is needed.
 * `playlistItems.list` costs 1 unit per page of 50 against a 10,000/day quota, and
 * `videos.list` (for durations) the same, so quota is not a constraint here.
 *
 * Errors are **worded per case** rather than collapsed into "sync failed", because the one that
 * matters most is unactionable otherwise: with an API key, a private playlist and a deleted
 * playlist both return `404 playlistNotFound`. The API never says "this is private", so the
 * message cannot claim it does — it names both possibilities and points at OAuth.
 */

const API = 'https://www.googleapis.com/youtube/v3';

export class YouTubeError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
  }
}

export interface YouTubeConfig {
  apiKey: string;
  playlistIds: string[];
}

/**
 * Read config from the environment. Returns null when unset — the widget then no-ops the sync and
 * logs one line, exactly like Buy/Sell/Trade without Reddit credentials. Manual mixes, cues and
 * the whole UI still work.
 */
export function readConfig(env: NodeJS.ProcessEnv = process.env): YouTubeConfig | null {
  const apiKey = env.YOUTUBE_API_KEY?.trim();
  const playlistIds = (env.YOUTUBE_PLAYLIST_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!apiKey || playlistIds.length === 0) return null;
  return { apiKey, playlistIds };
}

export interface PlaylistItem {
  videoId: string;
  /** Raw from the API — may be the `Deleted video` / `Private video` sentinel. */
  title: string;
  addedToPlaylistAt: number;
}

interface ApiError {
  error?: { errors?: { reason?: string }[]; message?: string };
}

interface PlaylistItemsResponse {
  nextPageToken?: string;
  items?: {
    snippet?: {
      title?: string;
      publishedAt?: string;
      resourceId?: { videoId?: string };
    };
  }[];
}

interface VideosResponse {
  items?: { id?: string; contentDetails?: { duration?: string } }[];
}

async function call<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (res.ok) return (await res.json()) as T;

  let reason = 'unknown';
  let apiMessage = '';
  try {
    const body = (await res.json()) as ApiError;
    reason = body.error?.errors?.[0]?.reason ?? 'unknown';
    apiMessage = body.error?.message ?? '';
  } catch {
    // Non-JSON error body; the status alone has to carry it.
  }

  throw new YouTubeError(describe(res.status, reason, apiMessage), reason);
}

function describe(status: number, reason: string, apiMessage: string): string {
  if (reason === 'playlistNotFound' || status === 404) {
    return 'Playlist no longer visible with an API key — it may have been made private or deleted. A private playlist requires OAuth.';
  }
  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
    return 'YouTube API quota exhausted for today; sync will resume tomorrow.';
  }
  if (reason === 'keyInvalid' || reason === 'badRequest' || status === 400) {
    return 'YOUTUBE_API_KEY is invalid or expired.';
  }
  if (status === 403) {
    return `YouTube refused the request (${reason}). Check that the Data API v3 is enabled for this key.`;
  }
  return `YouTube API error ${status}${apiMessage ? `: ${apiMessage}` : ''}`;
}

/** Every item in a playlist, following pagination to the end. */
export async function fetchPlaylistItems(
  config: YouTubeConfig,
  playlistId: string,
): Promise<PlaylistItem[]> {
  const items: PlaylistItem[] = [];
  let pageToken: string | undefined;

  do {
    const url =
      `${API}/playlistItems?part=snippet&maxResults=50&playlistId=${encodeURIComponent(playlistId)}` +
      `&key=${encodeURIComponent(config.apiKey)}${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const page = await call<PlaylistItemsResponse>(url);

    for (const item of page.items ?? []) {
      const videoId = item.snippet?.resourceId?.videoId;
      if (!videoId) continue;
      items.push({
        videoId,
        title: item.snippet?.title ?? '',
        // publishedAt on a playlist item is when it was ADDED to the playlist, which is the
        // ordering the UI wants: the mix just added sits first.
        addedToPlaylistAt: Date.parse(item.snippet?.publishedAt ?? '') || Date.now(),
      });
    }
    pageToken = page.nextPageToken;
  } while (pageToken);

  return items;
}

/** Durations for up to 50 ids per call. Used to reject a timestamp past the end of a mix. */
export async function fetchDurations(
  config: YouTubeConfig,
  videoIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();

  for (let i = 0; i < videoIds.length; i += 50) {
    const chunk = videoIds.slice(i, i + 50);
    const url =
      `${API}/videos?part=contentDetails&id=${chunk.map(encodeURIComponent).join(',')}` +
      `&key=${encodeURIComponent(config.apiKey)}`;
    const page = await call<VideosResponse>(url);
    for (const item of page.items ?? []) {
      const seconds = parseIsoDuration(item.contentDetails?.duration);
      if (item.id && seconds !== null) out.set(item.id, seconds);
    }
  }

  return out;
}

/** ISO-8601 durations as YouTube emits them: `PT1H23M45S`. */
export function parseIsoDuration(iso: string | undefined): number | null {
  if (!iso) return null;
  const m = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return null;
  const [, d, h, min, s] = m;
  if (!d && !h && !min && !s) return null;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0);
}
