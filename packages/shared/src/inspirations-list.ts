// Shared types for the Inspirations List widget (Epic PD-377).

/**
 * A single track pulled from a Spotify playlist, normalised to the shape the
 * dashboard cares about. Shared between the server (Spotify client) and any
 * future web view so the fields are declared exactly once (PROJECT.md §5).
 */
export interface SpotifyTrack {
  /** Spotify's stable track id (the `id` on the track object, not the URI). */
  spotifyTrackId: string;
  /** Track title. */
  title: string;
  /** All credited artists, in Spotify's order. */
  artists: string[];
  /** Album name (empty string if Spotify omits it). */
  album: string;
  /** URL of the album artwork, or null when the album has no images. */
  artworkUrl: string | null;
  /** When the track was added to the playlist, as unix ms (PROJECT.md §5). */
  addedAt: number;
}
