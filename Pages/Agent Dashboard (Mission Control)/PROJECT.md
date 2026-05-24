# Personal Dashboard — Project Context

## What this is

A self-hosted personal dashboard website running locally on a Mac Mini M4 Pro, accessible from any personal device via Tailscale. It consists of a collection of widgets ranging from simple personal productivity apps (habit tracker, diary, pomodoro) to automation-heavy apps (music download tracker, library organization tools) to a Mission Control panel for monitoring and managing AI agent workflows (detailed spec available in MISSION_CONTROl_BUILDER.md). A multi-agent coding workflow (DIY Symphony) is built early in the process and used to accelerate building the rest of the project.

---

## Current status

**Phase:** 0 — Not started  
**Development machine:** MacBook Pro M2, 32GB RAM  
**Production target:** Mac Mini M4 Pro, 64GB unified memory (not yet acquired)  
**LLM during development:** Anthropic Claude API (enterprise subscription)  
**LLM in production:** Ollama (local), with Claude API as fallback

---

## Key decisions made

### Stack
- **Frontend:** SvelteKit (TypeScript) — prior experience with it
- **Backend/automation:** n8n (self-hosted, Community Edition)
- **Database:** PostgreSQL — chosen over SQLite from day one for reliability and queryability
- **ORM/migrations:** Drizzle ORM with migration files committed to repo
- **Containerization:** OrbStack (lighter than Docker Desktop on Apple Silicon), Docker Compose
- **Remote access:** Tailscale — private WireGuard mesh, no public port exposure
- **HTTPS:** Tailscale Serve for tailnet HTTPS certificates
- **External webhooks:** Tailscale Funnel scoped to n8n webhook port only
- **Notifications:** Ntfy (self-hosted, has iOS app) — used for agent job notifications and alerts
- **Local LLMs:** Ollama (model runner), starting with Qwen2.5-Coder 7B/14B on M2, larger models on M4 Pro
- **Task tracking for agent workflow:** Markdown files with YAML frontmatter in `tasks/` folder in monorepo

### Architecture
- Everything runs in a single `docker-compose.yml` in the monorepo root, with `docker-compose.override.yml` for local dev overrides
- SvelteKit server routes act as the API layer between the frontend and Postgres/n8n
- n8n talks to Postgres directly for workflow state; SvelteKit talks to Postgres via Drizzle
- Agent jobs write state to a shared `agent_jobs` Postgres table that both n8n and the dashboard frontend read
- Secrets live in `.env` files, committed to `.gitignore`, never hardcoded
- Schema changes always go through Drizzle migration files, never manual DB edits

### Monorepo structure
```
~/projects/dashboard/
├── docker-compose.yml
├── docker-compose.override.yml
├── .env                        # gitignored
├── .env.example
├── tasks/                      # markdown task files for agent workflow
│   └── task-001-habit-tracker.md
├── scripts/
│   ├── start-worktree.sh
│   ├── cleanup-worktree.sh
│   └── task-cli               # Node/Python script for task management
├── dashboard/                  # SvelteKit app
│   ├── src/
│   ├── drizzle/               # migration files
│   └── ...
└── worktrees/                  # git worktrees for agent tasks (gitignored)
    └── task-001/
```

### Task file schema (for DIY Symphony)
Each task is a markdown file with YAML frontmatter:
```yaml
---
id: task-001
title: Build habit tracker widget
status: todo          # todo | in-progress | in-review | done | rejected
assigned_to: null     # agent name or null
priority: high        # high | medium | low
created_at: 2026-05-05
notes: ""
---
Description of what needs to be built goes here.
Include relevant context, acceptance criteria, and any links to related code.
```

---

## Postgres schema (tables planned)

| Table | Purpose |
|---|---|
| `errors` | All n8n workflow errors, surfaced in Mission Control |
| `agent_jobs` | Active and historical agent workflow runs |
| `review_items` | Unified queue for library organization (photos, maps, DJ, video) |
| `habits` | Habit definitions and daily completion records |
| `workout_log` | Exercise sessions and sets |
| `pomodoro_sessions` | Focus sessions with timestamps and notes |
| `diary_entries` | Daily diary entries (markdown/JSON) |
| `songs` | Download tracker: wanted/searching/downloaded songs |
| `artists` | Artists tracked for download monitoring |
| `download_attempts` | Log of slskd download attempts per song |

---

## n8n workflow inventory (planned)

| Workflow | Trigger | Purpose |
|---|---|---|
| Error handler | Any workflow failure | Write to `errors` table, send Ntfy notification |
| Agent fan-out | Manual / scheduled | Pick todo tasks, spawn parallel agent workers |
| Agent worker | Sub-workflow | Single task: worktree → Claude Code → commit → notify |
| Spotify poller | Cron (hourly) | Detect new playlist additions, add to `songs` |
| YouTube poller | Cron (hourly) | Detect new playlist additions, add to `songs` |
| slskd downloader | New wanted song | Search slskd, download best match, update status |
| Daily review queue | Cron (daily) | Surface 5 unorganized items per active library |
| Photos importer | Manual / cron | Fetch new Google Photos, add to review queue |

---

## External API integrations (planned)

| Service | Purpose | Auth method |
|---|---|---|
| Anthropic | Claude API for agent tasks | API key |
| Spotify | Playlist polling | OAuth2 via n8n credential |
| YouTube | Playlist polling | OAuth2 via Google Cloud project |
| Google Photos | Library organization widget | OAuth2 via Google Cloud project |
| Google Maps | Saved places widget | Google Takeout export or Maps API |
| slskd | Music download backend | Local API key |
| MusicBrainz | Song metadata lookup | Public API (no auth) |

---

## Phase plan

### Phase 0: M2 Foundation ✅ / 🔲
- [ ] Install OrbStack
- [ ] Install Homebrew, Git
- [ ] Set up SSH key, create GitHub repo for project
- [ ] Install Tailscale, add MacBook Pro + iPhone to tailnet
- [ ] Enable Tailscale Serve for HTTPS on MacBook tailnet hostname
- [ ] Install Ollama, pull Qwen2.5-Coder 7B or 14B
- [ ] Create `~/projects/dashboard/` monorepo folder
- [ ] Create skeleton `docker-compose.yml`

### Phase 1: n8n + Postgres
- [ ] Add Postgres to Docker Compose with persistent volume and `.env` credentials
- [ ] Add n8n to Docker Compose with Postgres backend and Tailscale `WEBHOOK_URL`
- [ ] Add `docker-compose.override.yml` for local dev overrides
- [ ] Verify n8n accessible at Tailscale HTTPS URL from MacBook and phone
- [ ] Create Anthropic API credential in n8n
- [ ] Create Ollama credential in n8n
- [ ] Set up Tailscale Funnel scoped to n8n webhook port
- [ ] Build and test end-to-end proof-of-concept workflow
- [ ] Set up error workflow writing to `errors` table + Ntfy notification
- [ ] Configure daily Postgres backup via n8n scheduled workflow

### Phase 2: Dashboard Shell (Minimal)
- [ ] Initialize SvelteKit project in `dashboard/` with TypeScript, ESLint, Prettier
- [ ] Install and configure Drizzle ORM with Postgres connection
- [ ] Define initial schema and run first migration
- [ ] Build responsive dashboard shell with sidebar/nav and widget grid placeholder
- [ ] Implement simple password auth via SvelteKit hooks and session cookie
- [ ] Add SvelteKit app to Docker Compose
- [ ] Verify accessible at Tailscale HTTPS URL on MacBook and phone
- [ ] Add one placeholder "hello world" widget to prove rendering pattern

### Phase 3: DIY Symphony (Multi-Agent Coding Workflow)
- [ ] Create `tasks/` folder, define markdown schema, write first real tasks
- [ ] Build `task-cli` script (list, claim, complete tasks)
- [ ] Learn and practice `git worktree` manually before automating
- [ ] Write `start-worktree.sh` and `cleanup-worktree.sh` scripts
- [ ] Build single-agent n8n workflow (trigger → claim task → worktree → Claude Code → wait for commit → notify → approve/reject loop)
- [ ] Set up Ntfy notifications with diff summary and approve/reject webhook URLs
- [ ] Test full single-agent loop end-to-end
- [ ] Add `agent_jobs` table to Postgres
- [ ] Add agent job semaphore mechanism (Postgres counter) to cap parallel agents
- [ ] Build fan-out workflow for parallel tasks (start with max 2)
- [ ] Build basic Mission Control widget in dashboard: active jobs, status, approve/reject buttons

### Phase 4: Mission Control Widget (Full)
- [ ] Connect to n8n REST API for execution history and run status
- [ ] Build workflow status panel (recent executions, pass/fail, duration)
- [ ] Build activity feed from `agent_jobs` table and n8n execution logs
- [ ] Build task board view (Kanban: Todo / In Progress / Review / Done) from markdown task files
- [ ] Build manual trigger panel for kicking off workflows from dashboard
- [ ] Build error feed from `errors` table
- [ ] Add polling for real-time feel (every 10-30 seconds)

### Phase 5: Simple Widgets
- [ ] **Habit tracker** — daily checklist, streaks, calendar heatmap
- [ ] **Workout log** — session entry, exercise history, progression stats, templates
- [ ] **Pomodoro timer** — configurable timer, session log, daily/weekly stats, Ntfy notifications
- [ ] **Diary** — TipTap rich text editor, date navigation, full-text search via Postgres tsvector

### Phase 6: Download Tracker
- [ ] Define `songs`, `artists`, `download_attempts` schema and migrations
- [ ] Build manual song entry UI with MusicBrainz/Spotify metadata lookup
- [ ] Build song queue view with status badges
- [ ] Build n8n Spotify playlist poller workflow
- [ ] Build n8n YouTube playlist poller workflow
- [ ] Build n8n slskd search + download workflow
- [ ] Handle multi-result selection UI for ambiguous matches
- [ ] Post-download file organization and ID3 tagging

### Phase 7: Library Organization Apps
- [ ] Define `review_items` schema (generic, with `library` discriminator and JSONB metadata)
- [ ] Build generic review queue UI component (item display, action buttons, daily progress, "done/give me more")
- [ ] Build n8n daily queue workflow template
- [ ] **Google Photos** — OAuth setup, initial import, star/album UI, write-back via Photos API
- [ ] **Google Maps** — Takeout import, category tagging UI, filtered export
- [ ] **DJ library** — folder scan or Rekordbox import, energy/genre/mood tagging, sidecar DB or ID3 write-back, Ollama tag suggestions
- [ ] **Video folder** — folder scan, ffmpeg thumbnail extraction, title/people/event tagging, file move and rename

---

## Cross-cutting rules (always follow)

- All secrets in `.env`, never committed to git
- All Postgres changes via Drizzle migration files, never manual edits
- All n8n workflows have an error branch writing to `errors` table
- All external API polling uses conservative intervals and handles 429s with exponential backoff
- All review queue UIs designed mobile-first (swipeable card pattern for phone use)
- Update this document whenever a significant decision is made or a phase is completed

---

## Migration path: M2 → Mac Mini M4 Pro

When the Mac Mini arrives:
1. Export Postgres via `pg_dump`
2. Copy repo and `.env` files to Mac Mini
3. Update Tailscale device (add Mac Mini, optionally remove MacBook as host)
4. Update `WEBHOOK_URL` and any hostname references in `.env`
5. Import Postgres dump
6. Bring up Docker Compose on Mac Mini
7. Swap Anthropic API for Ollama in n8n credentials (or keep both)
8. Verify everything via Tailscale from MacBook and phone

The application code and n8n workflows do not change.

---

## Notes and open questions

- Decide on notification channel before Phase 3: Ntfy (self-hosted) is the current plan
- Google Cloud project needs to be created before Phase 6/7 for OAuth credentials — can do this early
- slskd needs to already be running and configured before Phase 6 download workflows
- Consider whether Linear free tier is preferable to markdown task files for the agent workflow — markdown is simpler to start, Linear adds a better UI; can migrate later
- DJ library tagging: confirm whether to write back to ID3 tags directly or maintain a sidecar SQLite DB — depends on which DJ software is in use
