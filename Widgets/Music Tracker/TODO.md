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

- YouTube playlists (yt-dlp + YouTube Data API)
- SoundCloud likes / playlists
- Bandcamp wishlist / collection
- Each implements the `MusicSource` interface defined in MVP.

## Auto-download workflow

- For tracks in `wanted` status with no Lidarr fit, query a configurable list of mp3 download sites.
- Or attempt direct download via yt-dlp where applicable.
- Downloads land in a staging folder; user reviews before promoting to library.

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
