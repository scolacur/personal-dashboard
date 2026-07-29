import { describe, it, expect, vi } from 'vitest';
import type { Page, PlaylistedTrack, Track } from '@spotify/web-api-ts-sdk';
import {
  getPlaylistTracks,
  mapPlaylistItemToTrack,
  readSpotifyConfig,
  RefreshTokenAuthStrategy,
  type PlaylistItemsApi,
} from './spotify';

function makeLogger() {
  return {
    info: vi.fn<(message: string) => void>(),
    warn: vi.fn<(message: string) => void>(),
    error: vi.fn<(message: string, error?: unknown) => void>(),
  };
}

const FULL_ENV = {
  SPOTIFY_CLIENT_ID: 'client-id',
  SPOTIFY_CLIENT_SECRET: 'client-secret',
  SPOTIFY_REFRESH_TOKEN: 'refresh-token',
} as NodeJS.ProcessEnv;

function makeItem(overrides: Partial<Track> = {}, addedAt = '2024-01-02T03:04:05Z'): PlaylistedTrack<Track> {
  const track = {
    id: 'track-1',
    name: 'Song One',
    artists: [{ name: 'Artist A' }, { name: 'Artist B' }],
    album: { name: 'Album X', images: [{ url: 'https://img/large.jpg' }, { url: 'https://img/small.jpg' }] },
    ...overrides,
  } as unknown as Track;
  return { added_at: addedAt, track } as unknown as PlaylistedTrack<Track>;
}

function makePage(items: PlaylistedTrack<Track>[], total: number, next: string | null): Page<PlaylistedTrack<Track>> {
  return { href: '', items, limit: 50, next, offset: 0, previous: null, total } as Page<PlaylistedTrack<Track>>;
}

describe('readSpotifyConfig', () => {
  it('returns configured when all vars are present', () => {
    const result = readSpotifyConfig(FULL_ENV);
    expect(result.configured).toBe(true);
    if (result.configured) {
      expect(result.config).toEqual({
        clientId: 'client-id',
        clientSecret: 'client-secret',
        refreshToken: 'refresh-token',
      });
    }
  });

  it('reports every missing var and treats blank/whitespace as missing', () => {
    const result = readSpotifyConfig({
      SPOTIFY_CLIENT_ID: '  ',
      SPOTIFY_CLIENT_SECRET: '',
    } as NodeJS.ProcessEnv);
    expect(result.configured).toBe(false);
    if (!result.configured) {
      expect(result.missing).toEqual([
        'SPOTIFY_CLIENT_ID',
        'SPOTIFY_CLIENT_SECRET',
        'SPOTIFY_REFRESH_TOKEN',
      ]);
    }
  });
});

describe('mapPlaylistItemToTrack', () => {
  it('maps all fields and converts added_at to unix ms', () => {
    const mapped = mapPlaylistItemToTrack(makeItem());
    expect(mapped).toEqual({
      spotifyTrackId: 'track-1',
      title: 'Song One',
      artists: ['Artist A', 'Artist B'],
      album: 'Album X',
      artworkUrl: 'https://img/large.jpg',
      addedAt: Date.parse('2024-01-02T03:04:05Z'),
    });
  });

  it('returns null artwork when the album has no images', () => {
    const mapped = mapPlaylistItemToTrack(
      makeItem({ album: { name: 'No Art', images: [] } } as unknown as Partial<Track>),
    );
    expect(mapped?.artworkUrl).toBeNull();
  });

  it('skips local/unavailable tracks with a null id', () => {
    const item = makeItem({ id: null } as unknown as Partial<Track>);
    expect(mapPlaylistItemToTrack(item)).toBeNull();
  });
});

describe('getPlaylistTracks', () => {
  it('no-ops with a logged reason when env is unset', async () => {
    const logger = makeLogger();
    const tracks = await getPlaylistTracks('playlist-1', { env: {} as NodeJS.ProcessEnv, logger });
    expect(tracks).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('not configured');
    expect(logger.warn.mock.calls[0][0]).toContain('SPOTIFY_CLIENT_ID');
  });

  it('no-ops with a logged reason when the playlist id is blank', async () => {
    const logger = makeLogger();
    const tracks = await getPlaylistTracks('   ', { env: FULL_ENV, logger });
    expect(tracks).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('fetches and paginates through every page of tracks', async () => {
    const getPlaylistItems = vi
      .fn()
      .mockResolvedValueOnce(makePage([makeItem({ id: 'a' } as Partial<Track>)], 2, 'next-url'))
      .mockResolvedValueOnce(makePage([makeItem({ id: 'b' } as Partial<Track>)], 2, null));
    const apiFactory = (): PlaylistItemsApi => ({ playlists: { getPlaylistItems } });

    const tracks = await getPlaylistTracks('playlist-1', {
      env: FULL_ENV,
      logger: makeLogger(),
      apiFactory,
    });

    expect(tracks.map((t) => t.spotifyTrackId)).toEqual(['a', 'b']);
    expect(getPlaylistItems).toHaveBeenCalledTimes(2);
    expect(getPlaylistItems.mock.calls[0]).toEqual(['playlist-1', undefined, undefined, 50, 0]);
    expect(getPlaylistItems.mock.calls[1]).toEqual(['playlist-1', undefined, undefined, 50, 1]);
  });

  it('returns [] and logs the error when the API throws (never crashes)', async () => {
    const logger = makeLogger();
    const apiFactory = (): PlaylistItemsApi => ({
      playlists: { getPlaylistItems: vi.fn().mockRejectedValue(new Error('boom')) },
    });

    const tracks = await getPlaylistTracks('playlist-1', { env: FULL_ENV, logger, apiFactory });

    expect(tracks).toEqual([]);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe('RefreshTokenAuthStrategy', () => {
  function tokenResponse(expiresIn: number, accessToken = 'access-1'): Response {
    return new Response(
      JSON.stringify({ access_token: accessToken, token_type: 'Bearer', expires_in: expiresIn }),
      { status: 200 },
    );
  }

  it('requests a token via the refresh-token grant with Basic auth and caches it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(tokenResponse(3600));
    const strategy = new RefreshTokenAuthStrategy('cid', 'secret', 'refresh', fetchImpl as typeof fetch);

    const token = await strategy.getOrCreateAccessToken();
    expect(token.access_token).toBe('access-1');

    // Second call is served from cache (still valid) — no extra fetch.
    await strategy.getOrCreateAccessToken();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://accounts.spotify.com/api/token');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('cid:secret').toString('base64')}`);
    const body = init.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh');
  });

  it('re-fetches once the cached token has expired', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse(0, 'access-1')) // expires immediately (skew clamps to now)
      .mockResolvedValueOnce(tokenResponse(3600, 'access-2'));
    const strategy = new RefreshTokenAuthStrategy('cid', 'secret', 'refresh', fetchImpl as typeof fetch);

    const first = await strategy.getOrCreateAccessToken();
    expect(first.access_token).toBe('access-1');
    const second = await strategy.getOrCreateAccessToken();
    expect(second.access_token).toBe('access-2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws a descriptive error on a non-ok token response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('bad creds', { status: 400, statusText: 'Bad Request' }));
    const strategy = new RefreshTokenAuthStrategy('cid', 'secret', 'refresh', fetchImpl as typeof fetch);

    await expect(strategy.getOrCreateAccessToken()).rejects.toThrow('Spotify token refresh failed: 400');
  });
});
