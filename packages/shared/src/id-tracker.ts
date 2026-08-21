/**
 * ID Tracker — shared types and the two pure parsers both apps need.
 *
 * See `widgets/id-tracker/PROJECT.md` for the full spec. The parsers live here rather than in
 * the server widget because the web form validates with the *same* rules the write path
 * enforces: a timestamp the form accepts must never be rejected by the API, and vice versa.
 *
 * `packages/shared` has no test runner of its own (PD-2), so the specs for everything here live
 * in `apps/server/src/widgets/id-tracker/` — the same arrangement `isReady` uses.
 */

/** Shared job-run name. The web run surfaces read runs under this exact string, so a typo
 *  presents as "this job has never run" rather than as an error. */
export const ID_TRACKER_SYNC_JOB = 'id-tracker:playlist-sync';

/** Titles YouTube substitutes when a video is gone. Never adopted as a Mix's name. */
export const SENTINEL_TITLES = ['Deleted video', 'Private video'] as const;

export type MixSource = 'youtube' | 'manual';

export interface Mix {
  id: number;
  urlKey: string;
  url: string | null;
  source: MixSource;
  /** Steve's name for the mix. Only ever changed by him. */
  title: string;
  /** Last title seen from the API; never displayed as the mix's name. */
  youtubeTitle: string | null;
  dismissedTitle: string | null;
  youtubeVideoId: string | null;
  playlistId: string | null;
  durationS: number | null;
  inPlaylist: boolean;
  unavailable: boolean;
  archivedAt: number | null;
  addedToPlaylistAt: number | null;
  playlistSyncedAt: number | null;
  createdAt: number;
  cues: Cue[];
  /** Derived, not stored: YouTube's title differs from ours and we haven't dismissed it. */
  pendingRename: string | null;
}

export interface Cue {
  id: number;
  mixId: number;
  positionS: number;
  endPositionS: number | null;
  artist: string | null;
  title: string | null;
  remixer: string | null;
  notes: string | null;
  /** Derived on every write: artist AND title both non-empty. Never hand-set. */
  identified: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CreateMixInput {
  url?: string | null;
  title: string;
}

export interface CreateCueInput {
  mixId: number;
  /** Raw as typed — `42`, `47:10`, `1:23:45`, or a YouTube URL carrying `t=`. */
  position: string;
  endPosition?: string | null;
  artist?: string | null;
  title?: string | null;
  remixer?: string | null;
  notes?: string | null;
}

export type UpdateCueInput = Partial<Omit<CreateCueInput, 'mixId'>>;

export interface SyncSummary extends Record<string, unknown> {
  playlists: number;
  created: number;
  retitled: number;
  removed: number;
  unavailable: number;
  playlistsFailed: number;
}

/**
 * A mix's identity. Never the title — "Boiler Room" is not unique, and a retitle would fork the
 * mix. Every spelling of a YouTube URL collapses to the video id; a mix with no URL at all keys
 * off a slug of its title, which is what makes "a set off a USB stick" a first-class mix.
 */
export function mixUrlKey(input: { url?: string | null; title: string }): string {
  const url = input.url?.trim();
  if (!url) return `manual:${slugify(input.title)}`;

  const yt = parseYouTubeUrl(url);
  if (yt) return `youtube:${yt.videoId}`;

  try {
    const u = new URL(url.includes('://') ? url : `https://${url}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    return `${host}${path}`.toLowerCase();
  } catch {
    // Not a parseable URL — treat whatever was typed as a name rather than losing the mix.
    return `manual:${slugify(input.title)}`;
  }
}

/**
 * Does a tracked mix's title match what is being typed into the add-mix field?
 *
 * **Token containment, not substring.** The duplicate this check exists to catch is the near-miss
 * spelling — "Dekmantel 25" against a stored "Nina Kraviz | Dekmantel Festival 2025" — and a
 * substring match misses exactly that case, which is the only one that matters.
 *
 * A query shorter than two characters matches nothing; every mix matching is not a search result.
 */
export function mixMatchesQuery(title: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return false;
  const t = title.toLowerCase();
  return q.split(/\s+/).every((token) => t.includes(token));
}

export function slugify(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export interface YouTubeRef {
  videoId: string;
  /** Seconds from a `t=` parameter, when present. `?t=2535`, `?t=2535s` and `?t=1h30m15s`
   *  are all emitted by YouTube in the wild. */
  t: number | null;
}

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
]);

/** Video id is exactly 11 chars of [A-Za-z0-9_-]. Anchored, so a longer run fails rather than
 *  silently truncating to a *different* video. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function parseYouTubeUrl(raw: string): YouTubeRef | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let u: URL;
  try {
    u = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (!YOUTUBE_HOSTS.has(host)) return null;

  let videoId: string | null = null;
  if (host === 'youtu.be') {
    videoId = u.pathname.slice(1).split('/')[0] ?? null;
  } else if (u.pathname === '/watch') {
    videoId = u.searchParams.get('v');
  } else {
    // /embed/<id>, /v/<id>, /shorts/<id>, /live/<id>
    const m = /^\/(?:embed|v|shorts|live)\/([^/?#]+)/.exec(u.pathname);
    videoId = m?.[1] ?? null;
  }

  if (!videoId || !VIDEO_ID.test(videoId)) return null;
  return { videoId, t: parseTimeParam(u.searchParams.get('t')) };
}

function parseTimeParam(t: string | null): number | null {
  if (!t) return null;
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

export type ParseResult = { ok: true; seconds: number } | { ok: false; error: string };

/**
 * Parse a typed timestamp into seconds.
 *
 * **One rule: the rightmost field is always seconds.** `SS`, `MM:SS` and `HH:MM:SS` are the same
 * parse rather than three cases, so `42` is 42 seconds. Predictable beats clever — a parser that
 * guesses "42 probably means minutes" behaves differently depending on what it thinks you meant.
 *
 * A value >59 in any non-leading field is rejected rather than normalised: `1:75` is a typo far
 * more often than it is shorthand for 135 seconds.
 *
 * Also accepts a pasted YouTube URL carrying `t=`, because that is genuinely what is on the
 * clipboard after pausing at the moment worth logging.
 */
export function parsePosition(raw: string): ParseResult {
  const input = raw.trim();
  if (!input) return { ok: false, error: 'Enter a timestamp.' };

  const yt = parseYouTubeUrl(input);
  if (yt) {
    if (yt.t === null) return { ok: false, error: 'That link has no timestamp in it.' };
    return { ok: true, seconds: yt.t };
  }

  const parts = input.split(':');
  if (parts.length > 3) return { ok: false, error: 'Use HH:MM:SS, MM:SS or seconds.' };

  const nums: number[] = [];
  for (const part of parts) {
    const p = part.trim();
    if (!/^\d{1,3}$/.test(p)) return { ok: false, error: 'Use HH:MM:SS, MM:SS or seconds.' };
    nums.push(Number(p));
  }

  // Every field but the leading one is a 0–59 sexagesimal digit.
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] > 59) return { ok: false, error: `"${parts[i].trim()}" is not a valid minutes/seconds value.` };
  }

  const seconds = nums.reduce((acc, n) => acc * 60 + n, 0);
  return { ok: true, seconds };
}

/** Display form. Hours only when there are hours — `47:10`, not `00:47:10`. */
export function formatPosition(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Deep link straight to the moment. The whole reason `positionS` is stored as a number. */
export function cueLink(mix: Pick<Mix, 'url' | 'youtubeVideoId'>, positionS: number): string | null {
  if (mix.youtubeVideoId) return `https://youtu.be/${mix.youtubeVideoId}?t=${positionS}`;
  return mix.url ?? null;
}

/** The derived `identified` flag. Exported so the server's write path and the UI agree by
 *  construction rather than by both remembering the rule. */
export function isIdentified(artist: string | null | undefined, title: string | null | undefined): boolean {
  return Boolean(artist?.trim()) && Boolean(title?.trim());
}

export function isSentinelTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  return (SENTINEL_TITLES as readonly string[]).includes(title.trim());
}

/**
 * Whether YouTube's current title should be offered as a rename.
 *
 * A sentinel never raises one: adopting "Private video" as the mix's name would destroy the only
 * record of what the mix actually is, which is the single worst outcome this widget can produce.
 */
export function pendingRename(mix: {
  title: string;
  youtubeTitle: string | null;
  dismissedTitle: string | null;
}): string | null {
  const yt = mix.youtubeTitle?.trim();
  if (!yt || isSentinelTitle(yt)) return null;
  if (yt === mix.title.trim()) return null;
  if (mix.dismissedTitle && yt === mix.dismissedTitle.trim()) return null;
  return yt;
}
