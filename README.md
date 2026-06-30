# Personal Dashboard

A self-hosted dashboard running on a Synology NAS in Docker, accessible via browser on the local network. It collects a set of widgets — small focused tools for music, productivity, and daily habits.

**Stack:** SvelteKit frontend, Fastify backend, SQLite via `better-sqlite3`, TypeScript throughout, SCSS for styles, Docker for deployment.

See [PROJECT.md](PROJECT.md) for architecture details and [TODO.md](TODO.md) for the full backlog.

---

## Pages

| Page | Description | Status |
|------|-------------|--------|
| **Home** | Widget tile grid. Each tile links to a widget's full-page view and has a flip animation for settings. | Built |
| **Productivity** | Groups productivity widgets: Pomodoro Timer, Morning Routine, Habit Log, and a weekly summary. | Not built |
| **Health / Fitness** | Groups health widgets: Habit Log, Workout Log, and body metrics. | Not built |
| **Music Production** | Page for music production tools. | Not built |
| **Music Discovery** | Groups music-discovery widgets: Concert Discovery, Festival Follower, and a release radar. | Not built |
| **Event Tracker** | Unified calendar view combining Concert Discovery and Festival Follower events. | Not built |
| **Inboxes** | Review queues for filing Spotify likes, Shazams, Ableton bounces, and DJ library tracks. | Not built |
| **Agent Dashboard** | Mission Control for the Sortie AI agent system: job kanban, activity feed, error log, and inbox for agent messages. | Not built |

---

## Widgets

### Music Tracker
Polls a Spotify playlist for new additions, scans the local DJ library folder, and fuzzy-matches each track against the library. Shows a review queue where you can confirm a match, mark a track as wanted, or ignore it. Also accepts manual track entries.

**Backend:** library scanner, metadata normalizer, and fuzzy matcher are all implemented. Database schema and HTTP routes are in place.  
**Frontend:** not built — the review queue, manual entry form, and log panel views have no UI yet.  
**Spotify poller:** not built.  
**Status: In progress**

---

### Pomodoro Timer
A focus timer (25-minute work intervals with breaks) that floats persistently in a corner of the screen.

**Status: Not built**

---

### Morning Routine
A daily checklist of morning tasks. Resets every day at midnight.

**Status: Not built**

---

### Habit Log
Track daily habits with a checkbox interface. Records completion history for streaks and a heatmap view.

**Status: Not built**

---

### Acute Strategies Generator
Fetches a random musical idea or technique from a personal list. Lets you add, edit, and remove items from the list. Inspired by Brian Eno's Oblique Strategies.

**Status: Not built**

---

### Music Picker
Plays music from a configured Spotify playlist or internet radio streams. Quick access to a curated set of stations.

**Status: Not built**

---

### Concert Diary
A personal log of concerts attended. Records artist, venue, date, photos, setlist, and notes.

**Status: Not built**

---

### Concert Discovery
Monitors Resident Advisor for upcoming shows by followed artists. Surfaces new events in a feed.

**Status: Not built**

---

### Festival Follower
Watches festival pages for lineup announcements and lineup updates. Alerts when something changes.

**Status: Not built**

---

### Vision Board
A goal-setting board with cards for long-term goals. Each card can hold a description, progress notes, and images.

**Status: Not built**

---

### Reminders
Set one-off reminders with a date and time. Fires a browser notification when the time arrives.

**Status: Not built**

---

### Diary
Private daily journal with full-text search and optional mood tracking.

**Status: Not built**

---

### Workout Log
Log gym sessions: exercises, sets, reps, weight. Tracks progress over time per exercise.

**Status: Not built**

---

### Chat
Conversational AI assistant using the Claude API. Persists conversation threads in SQLite.

**Status: Not built**

---

## Development

```sh
npm ci
npm run verify   # build + typecheck + lint + test
```

Copy `.env.example` to `.env` and fill in the variables before running.

## Deployment

Single Docker image built with a multi-stage Dockerfile. Fastify serves the SvelteKit static build at `/` and the API at `/api/*`.

```sh
docker compose up -d
```

The compose file mounts `./data` for SQLite and logs, and `/volume1/music/dj-library/tracks` (read-only) for the DJ library scanner.
