// First real Spotify API client in the repo (Epic PD-377, slice 1/3).
//
// Self-contained on purpose: future music widgets can lift this module wholesale
// (PROJECT.md lists `@spotify/web-api-ts-sdk` as the Spotify client). It uses the
// single-user, pre-provisioned refresh-token pattern the `.env.example` vars imply
// (SPOTIFY_CLIENT_ID / _SECRET / _REFRESH_TOKEN) — no interactive OAuth.
//
// The SDK's built-in refresh (AccessTokenHelpers.refreshCachedAccessToken) only
// sends `client_id`, i.e. the *public* PKCE client flow. Our env vars describe a
// *confidential* app (they include a client secret), whose refresh-token grant must
// authenticate with HTTP Basic `client_id:client_secret`. So we supply our own
// IAuthStrategy (RefreshTokenAuthStrategy) rather than one of the bundled strategies.
// See DECISIONS.md D-060.

import { NoOpErrorHandler, SpotifyApi } from '@spotify/web-api-ts-sdk';
import type {
  AccessToken,
  IAuthStrategy,
  Page,
  PlaylistedTrack,
  SdkConfiguration,
  Track,
} from '@spotify/web-api-ts-sdk';
import type { SpotifyTrack } from '@dashboard/shared';

const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';

/** Refresh this many seconds before the real expiry to avoid edge-of-expiry 401s. */
const EXPIRY_SKEW_SECONDS = 30;

/** Spotify caps playlist item pages at 50. */
const PAGE_SIZE = 50;

/** Minimal structural logger so this module has no hard dependency on Fastify/pino. */
export interface SpotifyLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

const defaultLogger: SpotifyLogger = {
  info: (message) => console.info(`[inspirations-list/spotify] ${message}`),
  warn: (message) => console.warn(`[inspirations-list/spotify] ${message}`),
  error: (message, error) =>
    console.error(`[inspirations-list/spotify] ${message}`, error ?? ''),
};

export interface SpotifyConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export type SpotifyConfigResult =
  | { configured: true; config: SpotifyConfig }
  | { configured: false; missing: string[] };

/**
 * Read the required Spotify credentials from the environment. Missing/blank vars
 * are reported (never thrown) so callers can no-op gracefully and the server still
 * boots without Spotify configured.
 */
export function readSpotifyConfig(env: NodeJS.ProcessEnv = process.env): SpotifyConfigResult {
  const clientId = env.SPOTIFY_CLIENT_ID?.trim();
  const clientSecret = env.SPOTIFY_CLIENT_SECRET?.trim();
  const refreshToken = env.SPOTIFY_REFRESH_TOKEN?.trim();

  const missing: string[] = [];
  if (!clientId) missing.push('SPOTIFY_CLIENT_ID');
  if (!clientSecret) missing.push('SPOTIFY_CLIENT_SECRET');
  if (!refreshToken) missing.push('SPOTIFY_REFRESH_TOKEN');

  if (!clientId || !clientSecret || !refreshToken) {
    return { configured: false, missing };
  }
  return { configured: true, config: { clientId, clientSecret, refreshToken } };
}

interface SpotifyTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
}

/**
 * Confidential-client refresh-token auth strategy. Obtains an access token via the
 * refresh-token grant (HTTP Basic `client_id:client_secret`), caches it, and
 * transparently re-obtains one once it has expired. `SpotifyApi.makeRequest` calls
 * `getOrCreateAccessToken()` on every request, so expiry is handled per request.
 */
export class RefreshTokenAuthStrategy implements IAuthStrategy {
  private cached: (AccessToken & { expires: number }) | null = null;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly refreshToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  // The SDK pushes its resolved config in here; we don't need it.
  setConfiguration(_configuration: SdkConfiguration): void {}

  async getOrCreateAccessToken(): Promise<AccessToken> {
    if (!this.cached || this.cached.expires <= Date.now()) {
      this.cached = await this.requestAccessToken();
    }
    return this.cached;
  }

  async getAccessToken(): Promise<AccessToken | null> {
    return this.cached;
  }

  removeAccessToken(): void {
    this.cached = null;
  }

  private async requestAccessToken(): Promise<AccessToken & { expires: number }> {
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
    });

    const response = await this.fetchImpl(SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basic}`,
      },
      body,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Spotify token refresh failed: ${response.status} ${response.statusText} ${detail}`.trim(),
      );
    }

    const json = (await response.json()) as SpotifyTokenResponse;
    const expiresIn = json.expires_in ?? 3600;
    return {
      access_token: json.access_token,
      token_type: json.token_type ?? 'Bearer',
      expires_in: expiresIn,
      // Spotify may omit refresh_token on a refresh response; reuse the stored one.
      refresh_token: json.refresh_token ?? this.refreshToken,
      expires: Date.now() + Math.max(0, expiresIn - EXPIRY_SKEW_SECONDS) * 1000,
    };
  }
}

/** The single method of the SDK this module depends on — kept narrow for testability. */
export interface PlaylistItemsApi {
  playlists: {
    getPlaylistItems(
      playlistId: string,
      market?: undefined,
      fields?: undefined,
      limit?: number,
      offset?: number,
    ): Promise<Page<PlaylistedTrack<Track>>>;
  };
}

export interface GetPlaylistTracksOptions {
  env?: NodeJS.ProcessEnv;
  logger?: SpotifyLogger;
  /** Injection seam for tests; defaults to a real SpotifyApi. */
  apiFactory?: (config: SpotifyConfig) => PlaylistItemsApi;
  /** Injection seam for the token-refresh + API fetch; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

function createSpotifyApi(config: SpotifyConfig, fetchImpl?: typeof fetch): PlaylistItemsApi {
  const strategy = new RefreshTokenAuthStrategy(
    config.clientId,
    config.clientSecret,
    config.refreshToken,
    fetchImpl,
  );
  // NoOpErrorHandler rethrows so getPlaylistTracks' own try/catch owns logging.
  return new SpotifyApi(strategy, {
    errorHandler: new NoOpErrorHandler(),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

function pickArtwork(images: Track['album']['images'] | undefined): string | null {
  return images && images.length > 0 ? images[0].url : null;
}

function parseAddedAt(addedAt: string | null | undefined): number {
  if (!addedAt) return 0;
  const ms = Date.parse(addedAt);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Map one playlist item to a SpotifyTrack. Returns null for entries with no usable
 * track (e.g. local files or unavailable tracks, which carry a null `id`).
 */
export function mapPlaylistItemToTrack(item: PlaylistedTrack<Track>): SpotifyTrack | null {
  const track = item.track;
  if (!track || track.id == null) return null;
  return {
    spotifyTrackId: track.id,
    title: track.name,
    artists: (track.artists ?? []).map((artist) => artist.name),
    album: track.album?.name ?? '',
    artworkUrl: pickArtwork(track.album?.images),
    addedAt: parseAddedAt(item.added_at),
  };
}

async function fetchAllPlaylistTracks(
  api: PlaylistItemsApi,
  playlistId: string,
): Promise<SpotifyTrack[]> {
  const tracks: SpotifyTrack[] = [];
  let offset = 0;

  for (;;) {
    const page = await api.playlists.getPlaylistItems(
      playlistId,
      undefined,
      undefined,
      PAGE_SIZE,
      offset,
    );

    for (const item of page.items) {
      const mapped = mapPlaylistItemToTrack(item);
      if (mapped) tracks.push(mapped);
    }

    const fetched = offset + page.items.length;
    if (page.items.length === 0 || page.next === null || fetched >= page.total) break;
    offset = fetched;
  }

  return tracks;
}

/**
 * Fetch all tracks of a Spotify playlist, normalised to SpotifyTrack.
 *
 * Never throws: if Spotify is not configured, or a network/API error occurs, it
 * logs a clear reason and returns an empty array so callers no-op gracefully and
 * the server keeps running (Done-When of PD-377 slice 1/3).
 */
export async function getPlaylistTracks(
  playlistId: string,
  options: GetPlaylistTracksOptions = {},
): Promise<SpotifyTrack[]> {
  const logger = options.logger ?? defaultLogger;
  const env = options.env ?? process.env;

  const id = playlistId?.trim();
  if (!id) {
    logger.warn('getPlaylistTracks called without a playlist id; returning no tracks.');
    return [];
  }

  const configResult = readSpotifyConfig(env);
  if (!configResult.configured) {
    logger.warn(
      `Spotify is not configured (missing ${configResult.missing.join(', ')}); returning no tracks.`,
    );
    return [];
  }

  const api = options.apiFactory
    ? options.apiFactory(configResult.config)
    : createSpotifyApi(configResult.config, options.fetchImpl);

  try {
    return await fetchAllPlaylistTracks(api, id);
  } catch (error) {
    logger.error(`Failed to fetch Spotify playlist ${id}`, error);
    return [];
  }
}
