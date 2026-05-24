# Personal Dashboard — PROJECT.md

A locally-hosted personal dashboard running on a Synology NAS in Docker, composed of widgets (mini-apps). The first widget is a music tracker that detects new additions to external playlists and tracks whether I already have them in my DJ library.

This document is the source of truth for project scope, architecture, and conventions. Feed it to a fresh agent in your IDE as starting context.

---

## 1. Scope

### MVP scope

- Dashboard shell (frontend + backend) ready to host multiple widgets
- One widget implemented end-to-end: **Music Tracker**
- Runs in Docker on Synology NAS
- Accessed via browser on LAN only (no auth)

### Music Tracker MVP features

- Poll one Spotify playlist every 12 hours for new additions
- Scan local DJ library folder (NAS-mounted) and index file metadata
- Match each new Spotify track against the library using a fuzzy metadata matcher with duration gating
- Store all detected tracks in SQLite with status (`new` / `in_library` / `wanted` / `acquired` / `ignored`)
- Review UI showing detected tracks side-by-side with their library match candidates
- Manual entry form for tracks not coming from any automated source
- Manual "trigger scan now" button
- Basic logging UI showing recent cron runs and their outcomes
- Link out to Lidarr's UI from the dashboard

### Explicitly NOT in MVP (lives in TODO.md)

- Lidarr API integration (auto-push detected tracks to Lidarr)
- Additional sources: YouTube, SoundCloud, Bandcamp
- Chromaprint/AcoustID fingerprint matching
- Auto-download flow (mp3 site queries, direct downloads)
- "Better quality version found" workflow
- Continuous monitoring for higher-quality versions of existing library tracks
- NAS-to-PC copy automation
- Additional widgets (habit tracker, workout log, pomodoro, diary, etc.)
- Authentication

---

## 2. Architecture

### Repo layout

Monorepo using npm workspaces.

```
dashboard/
├── apps/
│   ├── server/                    # Node + TypeScript + Fastify backend
│   │   ├── src/
│   │   │   ├── index.ts           # Entry point: starts Fastify, loads widgets
│   │   │   ├── db.ts              # SQLite connection, schema bootstrap
│   │   │   ├── schema.sql         # Idempotent schema, run on startup
│   │   │   ├── cron.ts            # Cron registry; widgets register jobs here
│   │   │   ├── logger.ts          # Pino logger + log persistence for UI
│   │   │   └── widgets/
│   │   │       └── music-tracker/
│   │   │           ├── index.ts           # Registers routes + cron jobs
│   │   │           ├── routes.ts          # HTTP handlers
│   │   │           ├── sources/           # Pluggable source implementations
│   │   │           │   ├── types.ts       # MusicSource interface
│   │   │           │   ├── spotify.ts     # Spotify playlist poller
│   │   │           │   └── manual.ts      # Manual entry "source"
│   │   │           ├── library.ts         # DJ library scanner + indexer
│   │   │           ├── matcher.ts         # Fuzzy matching logic
│   │   │           └── normalize.ts       # Metadata normalization rules
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── web/                       # Svelte + TypeScript + SCSS frontend
│       ├── src/
│       │   ├── app.html
│       │   ├── routes/
│       │   │   ├── +layout.svelte         # Dashboard shell (nav, theme)
│       │   │   ├── +page.svelte           # Home: widget tiles
│       │   │   └── widgets/
│       │   │       └── music-tracker/
│       │   │           ├── +page.svelte           # Main view
│       │   │           ├── ReviewQueue.svelte
│       │   │           ├── ManualEntry.svelte
│       │   │           ├── LogPanel.svelte
│       │   │           └── api.ts                  # Typed fetch wrappers
│       │   └── lib/
│       │       ├── widgets.ts             # Widget registry (tiles on home)
│       │       └── styles/                # Shared SCSS
│       ├── svelte.config.js
│       ├── vite.config.ts
│       └── package.json
├── packages/
│   └── shared/                    # Cross-cutting TS types
│       ├── src/
│       │   ├── music-tracker.ts   # Track, MatchCandidate, Status, etc.
│       │   └── index.ts
│       └── package.json
├── docker/
│   ├── Dockerfile
│   └── docker-compose.yml
├── data/                          # Persistent (mounted volume): SQLite, logs
├── .env.example
├── package.json                   # Workspaces root
├── TODO.md
└── PROJECT.md
```

### Stack

- **Runtime:** Node.js 20 LTS
- **Language:** TypeScript (strict mode) everywhere
- **Backend framework:** Fastify
- **Frontend:** SvelteKit (SSR off, just static + client; runs as a SPA served by Fastify in prod) + SCSS
- **Database:** SQLite via `better-sqlite3` (synchronous, fast, no extra service)
- **Scheduler:** `node-cron` for in-process scheduled jobs
- **Fuzzy matching:** `fuse.js`
- **Audio metadata:** `music-metadata`
- **Spotify client:** `@spotify/web-api-ts-sdk`
- **Logging:** `pino` (plus mirror to SQLite `logs` table for the UI)
- **Container:** single Docker image, both server and built web assets

### Widget convention

Adding a new widget is a 3-step process:

1. Create `apps/server/src/widgets/<name>/index.ts` exporting:
   ```ts
   export const widget: BackendWidget = {
     name: '<name>',
     registerRoutes(app: FastifyInstance) { /* ... */ },
     registerCron(cron: CronRegistry) { /* optional */ },
     bootstrapSchema(db: Database) { /* optional, idempotent */ },
   };
   ```
2. Add it to the widget list in `apps/server/src/index.ts`.
3. Create `apps/web/src/routes/widgets/<name>/+page.svelte` and register a tile in `apps/web/src/lib/widgets.ts`.

The dashboard home reads `widgets.ts` and renders a tile grid linking to each widget's route. Each widget owns its own backend tables (namespaced like `music_tracker_*`).

---

## 3. Music Tracker — detailed design

### Data model

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

### Sources (pluggable)

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

### Normalization

`normalize.ts` exports `normalize(input: { artist, title }): { normArtist, normTitle, normRemixer }`.

Rules:
1. Lowercase, strip diacritics (`fold-to-ascii` style)
2. Extract parentheticals matching `(... remix)`, `(... mix)`, `(... edit)`, `(... version)` from title → put remixer/mix-name into `normRemixer`, remove from title
3. Extract `feat./featuring/ft.` segments from title → fold into artist
4. Replace collaboration separators (`&`, `,`, ` x `, `vs.`, `with`) with a canonical separator
5. Sort multi-artist lists alphabetically
6. Strip filename-only noise from library files: leading track numbers (`01 - `), trailing catalog tags (`[LABEL001]`), file extensions
7. Collapse whitespace, trim

### Matcher

`matcher.ts` exports `findMatches(track: TrackRow, library: LibraryFileRow[]): MatchCandidate[]`.

Algorithm:
1. **Duration gate.** Filter library to files where `Math.abs(library.durationMs - track.durationMs) <= 3000`. If either side is missing duration, skip the gate (don't filter).
2. **Score survivors** using Fuse.js with weighted keys:
   - `normTitle`: 0.50
   - `normArtist`: 0.35
   - `normRemixer`: 0.15
3. Normalize Fuse's score (it returns 0 = perfect, 1 = worst) → confidence = `1 - fuseScore`.
4. Return candidates with confidence ≥ **0.65**.
5. If any candidate has confidence ≥ **0.85**, mark the track `in_library` automatically (still write all candidates to `music_tracker_matches`).

Tuning notes:
- Thresholds (`0.65`, `0.85`) and weights live in a config constant at the top of `matcher.ts` — expect to adjust after observing real data.
- Duration gate is the most important guard; do not weaken it without thought (3-min radio edit vs 7-min extended mix have identical tags).

### Jobs

`node-cron` schedules registered at startup:

- `spotify_poll` — every 12 hours: call Spotify source `fetchNew`, insert new tracks, run matcher for each, write match rows and status.
- `library_scan` — every 6 hours: walk the library folder, upsert `library_files` (skip unchanged by path+mtime+size), then re-run matcher for all `status='new'` tracks against the refreshed library.

Both jobs also exposed via POST endpoints for manual trigger. Every run writes a `music_tracker_runs` row (started/finished/ok/summary/error).

### HTTP API (under `/api/widgets/music-tracker`)

- `GET  /tracks?status=new&limit=...&offset=...` — paginated list with matches
- `GET  /tracks/:id` — single track with all match candidates and library file details
- `POST /tracks` — manual entry: `{ artist, title, remixer?, album?, year?, entryType?, notes? }`
- `POST /tracks/:id/status` — `{ status: 'wanted' | 'ignored' | 'acquired' | 'in_library' }`
- `POST /tracks/:id/matches/:matchId/confirm` — mark a specific candidate as the confirmed match (also sets track status to `in_library`)
- `POST /jobs/spotify-poll` — manually trigger
- `POST /jobs/library-scan` — manually trigger
- `GET  /runs?limit=50` — recent cron runs for the log panel
- `GET  /config` — returns `{ lidarrUrl }` so the frontend can link out

### Frontend views

Routes:
- `/` — dashboard home, tile grid
- `/widgets/music-tracker` — main music tracker view, tabs: **Review**, **All Tracks**, **Manual Entry**, **Logs**

**Review tab** — default view, shows tracks with `status='new'` that have at least one match candidate, plus tracks with `status='new'` and no match candidates (the "wanted" candidates).

Each row shows two columns side-by-side:
- **Left (detected):** raw artist, raw title, raw remixer, duration, source + context
- **Right (matches):** for each candidate above threshold, file path + parsed metadata + duration + score; "Confirm" button per candidate

Actions per row: **Confirm match** (set to in_library), **Mark wanted** (no match, I want it), **Ignore**.

**All Tracks tab** — filterable by status, same row layout.

**Manual Entry tab** — form: artist, title, remixer, album, year, type, notes. On submit: insert track, run matcher against current library, redirect to that track's detail showing match candidates.

**Logs tab** — table of recent `music_tracker_runs` rows. Show start/finish, job, trigger, ok/error, summary.

---

## 4. Configuration

`.env` (mounted into container; example in `.env.example`):

```
# Server
PORT=8080
DATA_DIR=/data

# Music Tracker
DJ_LIBRARY_PATH=/library          # mount of NAS DJ folder mirror
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
SPOTIFY_REFRESH_TOKEN=...
SPOTIFY_PLAYLIST_ID=...
LIDARR_URL=http://nas.local:8686  # used for the link-out button only in MVP
```

---

## 5. Docker / deployment

Single image, multi-stage build:

1. **Build stage:** install workspace deps, build `packages/shared`, build `apps/web` (Vite static output), build `apps/server` (tsc).
2. **Runtime stage:** Node 20-slim, copy server `dist/`, copy web build into `apps/web/build`, install production deps only. Fastify serves the web static assets at `/` and the API at `/api/*`.

`docker-compose.yml` mounts:
- `./data:/data` — SQLite file, logs
- `/volume1/music/dj-library-mirror:/library:ro` — DJ library (read-only from container's perspective; rsync from PC populates this via a separate scheduled task on the NAS)

Exposes one port (default 8080). No external auth — relies on LAN-only access.

---

## 6. Conventions and quality bar

- TypeScript `strict: true` everywhere. No `any` without an inline comment justifying it.
- Shared types between server and web live in `packages/shared` and are imported by both. Don't redeclare.
- Database access wrapped in small typed functions (no raw SQL in route handlers). Use `better-sqlite3` prepared statements.
- Each widget's backend code is self-contained in its folder; no cross-widget imports. If two widgets need to share something, it goes in `packages/shared` or a future `apps/server/src/lib/`.
- Time stored as unix ms (`number`) in SQLite, never as strings.
- All endpoints return JSON; errors as `{ error: string, code?: string }` with appropriate HTTP status.
- No tests required for MVP. Add them when something breaks twice.

---

## 7. Build order (suggested)

1. Workspace scaffolding: root `package.json` with workspaces, `apps/server` Fastify hello-world, `apps/web` SvelteKit hello-world, `packages/shared` empty package, Dockerfile that builds and runs the whole thing.
2. Dashboard shell: home route with tile grid, widget registry mechanism on both sides, one stub widget that just says "hello" to prove the convention.
3. Music tracker schema + library scanner: just the scanner and the library table. Verify it indexes the real folder correctly.
4. Music tracker normalize + matcher: unit-testable, build against a hand-rolled fixture before plugging in Spotify.
5. Music tracker Spotify source + cron: poll, insert tracks, run matcher.
6. Music tracker frontend: Review tab first (the most-used view), then All Tracks, Manual Entry, Logs.
7. Deploy to Synology, observe matcher behavior on real data, tune thresholds.

---

## 8. Open questions / things to revisit

- Matcher thresholds (`0.65` / `0.85`) and weights — will need tuning after a few weeks of real use. Track false positives and false negatives in a notes file.
- Whether `node-cron` is sufficient or if a real job queue (BullMQ) is needed — defer until a second source is added.
- Whether to add Lidarr API integration or stick with manual download workflow — defer to TODO.md, decide after living with MVP.
