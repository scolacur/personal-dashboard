# Music Tracker — PROJECT.md

A widget that detects when new tracks are added to external sources (playlists on Spotify, YouTube, and Soundcloud, and also accepts manual song input), tracks whether each track is already in Steve's DJ library, located on his PC. If not yet in the library, it gives the user the option to download the track through a variety of methods. The core loop: poll source → match against library → surface for review.

See also: [TODO.md](TODO.md)

---

## 1. MVP Scope

- Poll one Spotify playlist every 12 hours for new additions
- Scan local DJ library folder (NAS-mounted) and index file metadata
- Match each new Spotify track against the library using a fuzzy metadata matcher (title, artist, remixer)
- Store all detected tracks in SQLite with status (`new` / `in_library` / `wanted` / `acquired` / `ignored`)
- Review queue UI showing detected tracks side-by-side with their library match candidates
- Manual entry form for tracks not coming from any automated source, including artist & title
- Manual "trigger scan now" button
- Basic logging UI showing recent cron runs and their outcomes
- Link out to Lidarr's UI from the dashboard
- Source management UI so user can view, add & remove monitored sources

### Explicitly NOT in MVP

- Lidarr API integration (auto-push detected tracks to Lidarr)
- Additional sources: YouTube, SoundCloud, Bandcamp, reddit threads.
- Chromaprint/AcoustID fingerprint matching -- (spike to determine how this would actually work, might need to happen after the download since it might be difficult to obtain the audio file of previews from spotify etc)
- Download manager UI so user can view, enable & disable methods for attempting to actually download the files (these will need code changes to add) 
- Redundant Auto-download flows (multiple paths for downloading the track eg. queries to specific mp3 download websites, soulseek)
- "Better quality version found" workflow
- Continuous monitoring for higher-quality versions of existing library tracks
- NAS-to-PC copy automation
- Expand beyond DJ library to scanning Steve's main music library as well. Maybe there is a checkbox for "also add to dj library" when downloading the song.
- Expand beyond songs to also include DJ mixes & full albums
- Detect new releases from "watched" artists and labels
- Streaming fallback playlist — if a track can't be downloaded, surface a unified "streaming queue" linking to Bandcamp/YouTube/SoundCloud/Spotify in preference order, with optional in-app playback. This is its own widget (low priority).
- Music library archive layer — ability to hide artists/tracks from the player (Plexamp) without deleting them. Part of a broader library management page (low priority).

---

## 2. Data Model

```sql
-- Tracks: anything we've detected from any source (Spotify, manual, future YT/SC)
CREATE TABLE music_tracker_tracks (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,                -- 'spotify' | 'manual' | (future) 'youtube' | ...
  source_ref TEXT,                     -- e.g. spotify track URI, NULL for manual
  source_context TEXT,                 -- e.g. playlist name, for display
  raw_artist TEXT NOT NULL,            -- as provided by source / user
  raw_title TEXT NOT NULL,
  raw_remixer TEXT,                    -- if separately known
  raw_album TEXT,
  raw_year INTEGER,
  raw_notes TEXT,                      -- manual entries only
  entry_type TEXT,                     -- 'song' | 'album' | 'artist' | 'label' | 'mix' (manual only; default 'song')
  duration_ms INTEGER,
  norm_artist TEXT NOT NULL,           -- normalized for matching
  norm_title TEXT NOT NULL,
  norm_remixer TEXT,
  status TEXT NOT NULL DEFAULT 'new',  -- new | in_library | wanted | acquired | ignored
  detected_at INTEGER NOT NULL,        -- unix ms
  reviewed_at INTEGER,
  UNIQUE(source, source_ref)
);

-- Library files: indexed contents of the DJ folder
CREATE TABLE music_tracker_library_files (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,              -- for change detection on rescan
  raw_artist TEXT,
  raw_title TEXT,
  raw_remixer TEXT,
  raw_album TEXT,
  duration_ms INTEGER,
  norm_artist TEXT,
  norm_title TEXT,
  norm_remixer TEXT,
  indexed_at INTEGER NOT NULL
);

-- Match candidates: many-to-many between tracks and library files
CREATE TABLE music_tracker_matches (
  id INTEGER PRIMARY KEY,
  track_id INTEGER NOT NULL REFERENCES music_tracker_tracks(id) ON DELETE CASCADE,
  library_file_id INTEGER NOT NULL REFERENCES music_tracker_library_files(id) ON DELETE CASCADE,
  score REAL NOT NULL,                 -- 0..1
  is_confirmed INTEGER NOT NULL DEFAULT 0, -- user accepted this match
  UNIQUE(track_id, library_file_id)
);

-- Cron run log (used by the LogPanel UI)
CREATE TABLE music_tracker_runs (
  id INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  job TEXT NOT NULL,                   -- 'spotify_poll' | 'library_scan' | 'manual_scan'
  trigger TEXT NOT NULL,               -- 'cron' | 'manual'
  ok INTEGER,                          -- 1/0, NULL while running
  summary TEXT,                        -- e.g. "3 new tracks, 2 matched"
  error TEXT
);
```

---

## 3. Sources (pluggable)

```ts
// apps/server/src/widgets/music-tracker/sources/types.ts
export interface DetectedTrack {
  sourceRef: string;
  sourceContext?: string;
  artist: string;
  title: string;
  remixer?: string;
  album?: string;
  year?: number;
  durationMs?: number;
}

export interface MusicSource {
  name: string;                                  // 'spotify' | 'manual' | ...
  fetchNew(since: number): Promise<DetectedTrack[]>;
}
```

MVP implementations:
- `spotify.ts` — uses the Spotify Web API SDK with refresh-token auth; polls one playlist (configured via env var) and returns tracks added since the last successful run.
- `manual.ts` — not a poller; exposes a function called from the manual-entry route to create a track row directly. Implements the interface for uniformity but `fetchNew` is a no-op.

---

## 4. Normalization

`normalize.ts` exports `normalize(input: { artist, title }): { normArtist, normTitle, normRemixer }`.

Rules:
1. Lowercase, strip diacritics (`fold-to-ascii` style)
2. Extract parentheticals matching `(... remix)`, `(... mix)`, `(... edit)`, `(... version)` from title → put remixer/mix-name into `normRemixer`, remove from title
3. Extract `feat./featuring/ft.` segments from title → fold into artist
4. Replace collaboration separators (`&`, `,`, ` x `, `vs.`, `with`) with a canonical separator
5. Sort multi-artist lists alphabetically
6. Strip filename-only noise from library files: leading track numbers (`01 - `), trailing catalog tags (`[LABEL001]`), file extensions
7. Collapse whitespace, trim

---

## 5. Matcher

`matcher.ts` exports `findMatches(track: TrackRow, library: LibraryFileRow[]): MatchCandidate[]`.

Algorithm:
1. **Per-field fuzzy scoring** using Fuse.js. Each field is scored independently (separate Fuse instance per field, queried against the matching track field):
   - `normTitle`: weight 0.50
   - `normArtist`: weight 0.35
   - `normRemixer`: weight 0.15
2. Normalize Fuse's score (0 = perfect, 1 = worst) → confidence = `1 - fuseScore`.
3. Weight is redistributed proportionally when a field is absent on either side (missing fields don't penalise the score).
4. Return candidates with confidence ≥ **0.65**.
5. If any candidate has confidence ≥ **0.85**, mark the track `in_library` automatically (still write all candidates to `music_tracker_matches`).

**No duration gate.** Duration is not used in matching. Rationale: if we're looking for a radio edit and only an extended mix is in the library, we still want to surface it — missing a match entirely is worse than a false positive that the user dismisses. If false positives become a problem in practice, duration can be added as a weighted score component rather than a hard filter.

Tuning notes:
- Thresholds (`0.65`, `0.85`) and weights live in `MATCH_CONFIG` at the top of `matcher.ts` — expect to adjust after observing real data.

---

## 6. Jobs

`node-cron` schedules registered at startup:

- `spotify_poll` — every 12 hours: call Spotify source `fetchNew`, insert new tracks, run matcher for each, write match rows and status.
- `library_scan` — every 6 hours: walk the library folder, upsert `library_files` (skip unchanged by path+mtime+size), then re-run matcher for all `status='new'` tracks against the refreshed library.

Both jobs also exposed via POST endpoints for manual trigger. Every run writes a `music_tracker_runs` row (started/finished/ok/summary/error).

---

## 7. HTTP API

All routes under `/api/widgets/music-tracker`:

- `GET  /tracks?status=new&limit=...&offset=...` — paginated list with matches
- `GET  /tracks/:id` — single track with all match candidates and library file details
- `POST /tracks` — manual entry: `{ artist, title, remixer?, album?, year?, entryType?, notes? }`
- `POST /tracks/:id/status` — `{ status: 'wanted' | 'ignored' | 'acquired' | 'in_library' }`
- `POST /tracks/:id/matches/:matchId/confirm` — mark a specific candidate as the confirmed match (also sets track status to `in_library`)
- `POST /jobs/spotify-poll` — manually trigger
- `POST /jobs/library-scan` — manually trigger
- `GET  /runs?limit=50` — recent cron runs for the log panel
- `GET  /config` — returns `{ lidarrUrl }` so the frontend can link out

---

## 8. Frontend Views

Routes:
- `/widgets/music-tracker` — main view, tabs: **Review**, **All Tracks**, **Manual Entry**, **Logs**

**Review tab** — default view, shows tracks with `status='new'` that have at least one match candidate, plus tracks with `status='new'` and no match candidates (the "wanted" candidates).

Each row shows two columns side-by-side:
- **Left (detected):** raw artist, raw title, raw remixer, duration, source + context
- **Right (matches):** for each candidate above threshold, file path + parsed metadata + duration + score; "Confirm" button per candidate

Actions per row: **Confirm match** (set to in_library), **Mark wanted** (no match, I want it), **Ignore**.

**All Tracks tab** — filterable by status, same row layout.

**Manual Entry tab** — 2-step flow: first pick the entry type (Track / Mix / Artist / Label / Album), then fill in the type-appropriate fields:
- Track / Mix: Artist, Title, Notes
- Artist: Name
- Label: Name
- Album: Artist, Name

On submit: insert track, run matcher against current library, redirect to that track's detail showing match candidates.

**Logs tab** — table of recent `music_tracker_runs` rows. Show start/finish, job, trigger, ok/error, summary.

---

## 9. Configuration

Music Tracker env vars (full list in root `.env.example`):

```
DJ_LIBRARY_PATH=/library          # mount of NAS DJ folder mirror
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
SPOTIFY_REFRESH_TOKEN=...
SPOTIFY_PLAYLIST_ID=...           # single playlist; see note below
LIDARR_URL=http://nas.local:8686  # used for the link-out button only in MVP
```

**Spotify refresh token:** The auth flow requires a one-time OAuth dance to generate `SPOTIFY_REFRESH_TOKEN`. Easiest path is a small standalone Node script that runs once locally, or generate it through Spotify's developer console. The agent will likely ask — point it at one of these options.

**Single vs. multiple playlists:** `SPOTIFY_PLAYLIST_ID` is a single value. If you want multiple playlists from day one, say so before the agent builds the poller — it's easy to design in up front and a refactor later. Otherwise, single-playlist is the default and that's a reasonable starting point.

---

## 10. Open Questions

- Matcher thresholds (`0.65` / `0.85`) and weights — will need tuning after a few weeks of real use. Track false positives and false negatives in a notes file.
- Whether to add Lidarr API integration or stick with manual download workflow — defer to TODO.md, decide after living with MVP.
- Synology Docker quirks (mount paths, user/group IDs for the library folder) aren't worth specifying upfront — build it generically and adapt at deploy time when the actual environment is known.
