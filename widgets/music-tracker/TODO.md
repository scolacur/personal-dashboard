# TODO — Music Tracker Widget

## Lidarr API integration

- One-click "send to Lidarr" button on a track, hitting Lidarr's REST API.
- Look up artist/album via Lidarr's MusicBrainz-backed search.
- Handle "not found in MusicBrainz" case (common for mixes, bootlegs, white labels) — fall back to a Google/Bandcamp search link.
- Decide: do this per-track on user action, or auto-push everything in `wanted` status?

## Better matcher: Chromaprint / AcoustID fingerprinting

- Revisit only after observing matcher failure modes for 2–3 weeks.
- Implement if false-negative rate from tag inconsistency is the dominant problem.
- Requires `fpcalc` binary in Docker image and fingerprinting all library files (slow initial scan).
- Likely also requires downloading Spotify preview clips (30s, not always available) to fingerprint the incoming side.

## Additional sources

Each new source implements the `MusicSource` interface defined in MVP.

**Playlist / library sources (straightforward polling):**

- YouTube playlists (yt-dlp + YouTube Data API) — e.g. "DJ Songs to download", "Great Mixes 2025" (mix-typed)
- SoundCloud specific playlists / likes
- Bandcamp wishlist / collection + followed artists & labels
- NTS saved/followed list
- Shazam list — pull directly from Shazam (not via Spotify; requires separate credential)
- Multiple Spotify playlists — e.g. "DJ Ideas" in addition to the MVP playlist; `SPOTIFY_PLAYLIST_IDS` becomes a comma-separated list
- Resident Advisor (RA) followed artists — poll for new mixes/sets
- Each implements the `MusicSource` interface defined in the MVP (double-check whether this approach makes sense)

**Complex / scraping sources:**

- Reddit saved posts from r/theoverload — parse saved post links, visit each linked page, extract track/mix metadata (artist + title), add to tracker. Requires: Reddit API auth, link-following logic, metadata extraction heuristic (or LLM assist).

## Auto-download workflow

Nightly: attempt downloads for all `wanted` tracks via a configurable set of methods (mp3 download sites, yt-dlp). Downloads land in a staging/temp folder.

**Staging review inbox:**

- As long as any files sit in the staging folder, surface a notification ("New tracks downloaded — please review") in the dashboard notification center.
- Per file, show the track it came from + its detected quality. User actions:
  - **Delete & keep tracking** — this version is bad; ignore this specific file in future downloads but keep looking
  - **Delete & stop tracking** — already have it or no longer want it
  - **Add to music library, keep tracking** — promote to library, keep monitoring for better quality
  - **Add to music library & stop tracking** — done
- **"Also add to DJ library" checkbox** — copies the file to the DJ tracks folder in addition to the main library
- **"Is mix" checkbox** — adds the file to the Plexamp mixes playlist
- Auto-resolve to "stop tracking" when a 320 kbps MP3 or lossless file is confirmed added to the library; no need for manual confirmation in that case
- The tracker's knowledge of whether a track is in-library must be maintained independently of the temp folder (temp folder is transient; library status is durable)

## Metadata enrichment

When a track is added (from any source), enrich it with additional metadata from Discogs, Bandcamp, and/or Spotify — canonical artist name, label, release year, artwork. Useful for improving matcher accuracy and display quality. Design as an optional post-insert step so it doesn't block ingestion. Only add additional metadata if very confident it applies to the song.

## Duplicate detection & notification center

- Nightly job: detect tracker entries that likely refer to the same track (added from multiple sources, or manual + auto-detected). Flag as potential duplicates.
- Notification center surface in the dashboard for reconciling duplicates: keep one, merge, or dismiss.

## "Better quality version" workflow

- Track existing library entries too (not just new detections).
- Periodically check if a higher-quality version is available.
- UI for side-by-side accept/reject (current vs. candidate) with audio preview.
- Requires committing to fingerprinting first.

## Job queue

- Replace `node-cron` with BullMQ (or similar) once there are 3+ sources running concurrently.
- Adds retries, concurrency limits, persisted job state.

## NAS-to-PC copy

- One-click action to copy a file from a NAS folder to a specific folder on the PC.
- Needs either an agent running on the PC (small Node service) or an SMB write from the container.
- Out of scope until the download workflow is in place.
