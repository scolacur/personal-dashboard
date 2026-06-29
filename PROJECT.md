# Personal Dashboard — PROJECT.md

A locally-hosted personal dashboard running on a Synology NAS in Docker, composed of widgets (mini-apps). Widgets are customized tools to help me accomplish various tasks. Some interact with external APIs, some speak to a database we will create. Accessible via web browser.

Example widgets:

- A todo checklist, just for morning tasks, that refreshes every day.
- A simple Pomodoro timer that floats persistently in the bottom corner of the screeen.
- A habit tracker
- A workout log
- Acute strategies generator - a simple app that fetches random ideas from a list of musical ideas and techniques that i maintain. it also allows me to add/remove/edit items in that list.
- A music tracker that detects new additions to external playlists and tracks whether I already have them in my DJ library.
-

Each widget should exist in a movable and resizable card, like in a datadog dashboard.

This document is the source of truth for project scope, architecture, and conventions.

---

## 1. Scope

### MVP scope

- Dashboard shell (frontend + backend) ready to host multiple widgets
- One widget implemented end-to-end: **Music Tracker** — see [widgets/music-tracker/PROJECT.md](widgets/music-tracker/PROJECT.md)
- Runs in Docker on Synology NAS
- Accessed via browser on LAN only (no auth)

### Explicitly NOT in MVP (lives in TODO.md)

- Additional widgets (habit tracker, workout log, pomodoro, diary, etc.)
- Authentication
- Accessible outside of LAN (set up reverse proxy) so user can access it on their phone off of the wifi network the NAS sits on

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
     registerRoutes(app: FastifyInstance) {
       /* ... */
     },
     registerCron(cron: CronRegistry) {
       /* optional */
     },
     bootstrapSchema(db: Database) {
       /* optional, idempotent */
     },
   };
   ```
2. Add it to the widget list in `apps/server/src/index.ts`.
3. Create `apps/web/src/routes/widgets/<name>/+page.svelte` and register a tile in `apps/web/src/lib/widgets.ts`.

The dashboard home reads `widgets.ts` and renders a tile grid linking to each widget's route. Each widget owns its own backend tables (namespaced like `music_tracker_*`).

---

## 3. Configuration

`.env` (mounted into container; example in `.env.example`):

```
# Server
PORT=8080
DATA_DIR=/data
```

Widget-specific env vars are documented in each widget's PROJECT.md.

---

## 4. Docker / deployment

Single image, multi-stage build:

1. **Build stage:** install workspace deps, build `packages/shared`, build `apps/web` (Vite static output), build `apps/server` (tsc).
2. **Runtime stage:** Node 20-slim, copy server `dist/`, copy web build into `apps/web/build`, install production deps only. Fastify serves the web static assets at `/` and the API at `/api/*`.

`docker-compose.yml` mounts:

- `./data:/data` — SQLite file, logs
- `/volume1/music/dj-library-mirror:/library:ro` — DJ library (read-only from container's perspective; rsync from PC populates this via a separate scheduled task on the NAS)

Exposes one port (default 8080). No external auth — relies on LAN-only access.

---

## 5. Conventions and quality bar

- TypeScript `strict: true` everywhere. No `any` without an inline comment justifying it.
- Shared types between server and web live in `packages/shared` and are imported by both. Don't redeclare.
- Database access wrapped in small typed functions (no raw SQL in route handlers). Use `better-sqlite3` prepared statements.
- Each widget's backend code is self-contained in its folder; no cross-widget imports. If two widgets need to share something, it goes in `packages/shared` or a future `apps/server/src/lib/`.
- Time stored as unix ms (`number`) in SQLite, never as strings.
- All endpoints return JSON; errors as `{ error: string, code?: string }` with appropriate HTTP status.
- No tests required for MVP. Add them when something breaks twice.

---

## 6. Build order (suggested)

1. Workspace scaffolding: root `package.json` with workspaces, `apps/server` Fastify hello-world, `apps/web` SvelteKit hello-world, `packages/shared` empty package, Dockerfile that builds and runs the whole thing.
2. Dashboard shell: home route with tile grid, widget registry mechanism on both sides, one stub widget that just says "hello" to prove the convention.
3. Music tracker schema + library scanner: just the scanner and the library table. Verify it indexes the real folder correctly.
4. Music tracker normalize + matcher: unit-testable, build against a hand-rolled fixture before plugging in Spotify.
5. Music tracker Spotify source + cron: poll, insert tracks, run matcher.
6. Music tracker frontend: Review tab first (the most-used view), then All Tracks, Manual Entry, Logs.
7. Deploy to Synology, observe matcher behavior on real data, tune thresholds.

---

## 7. Open questions / things to revisit

- Whether `node-cron` is sufficient or if a real job queue (BullMQ) is needed — defer until a second widget with scheduling is added.
