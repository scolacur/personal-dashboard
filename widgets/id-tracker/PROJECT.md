# ID Tracker — PROJECT.md

A widget for logging **IDs** — the moments in a DJ mix where an unidentified track is playing —
and working them from "what *is* that?" to a named artist/title. Mixes are pulled automatically
from a set of YouTube playlists; mixes from anywhere else (SoundCloud, a friend's b2b off a USB
stick) are added by hand and live alongside them.

Status: **specified, not built.** This document is the output of a grilling session and is the
spec the implementation tickets will be cut from.

---

## 1. Glossary

Definitions only — no implementation detail. Terms here are widget-local; cross-cutting terms
live in the root [PROJECT.md](../../PROJECT.md) §9.

**Mix**:
A DJ mix — one row, identified by its **url_key**, holding zero or more **Cues**. Created either
by the **playlist sync** (`source='youtube'`) or by hand (`source='manual'`). A Mix with no URL at
all is a legitimate Mix (a set off a USB stick, a personal recording). A Mix outlives the playlist
it came from: sync never deletes one, only Steve does.
_Avoid_: calling a Mix a "video" — a YouTube video is one way a Mix is reachable, not what it is.

**Cue**:
A marked point in a **Mix** — "at 42:15 there's something I need to identify." Carries
`position_s`, optional `artist` / `title` / `remixer`, and free-text `notes`. A Mix can hold many
Cues. The user-facing name for a Cue is an **ID**; the code says *cue* because `id` is the primary
key column on every table in this repo and the collision is unreadable.
_Avoid_: "timestamp" for the entity — the timestamp is one *field* on a Cue.

**identified**:
A **derived, persisted** boolean on a Cue: true exactly when `artist` and `title` are both
non-empty. Recomputed on every Cue write, never hand-set, so it cannot disagree with the fields it
describes. Same shape as the board's `ready` flag ([[D-058]]). Drives the widget's central
question — *which of my IDs are still open?*
_Avoid_: reading it as "I have the file." Whether a track is in the DJ library is **Music
Tracker's** answer, not this widget's (see §8, V2).

**url_key**:
A Mix's identity — a computed, UNIQUE canonical key, never the title. YouTube URLs collapse to
`youtube:<11-char video id>` regardless of spelling (`youtu.be/…`, `m.youtube.com/…`, `&list=`,
`&t=`); other URLs to `<host><path>` lowercased, `www.` and trailing slash and query stripped; a
Mix with no URL to `manual:<slug of title>`.
_Avoid_: using the title as identity — "Boiler Room" is not unique, and a retitle would fork the
Mix.

**Playlist sync**:
The job that reads the configured YouTube playlists and reconciles them into Mixes. **Additive and
non-destructive**: it creates Mixes, updates `youtube_title`, and flags removals — it never deletes
a Mix, never overwrites the display `title`, and reconciles removals only from a fully successful
fetch. Runs on cron, on a stale render, and from the **Sync now** button; every run is recorded
through the shared job-run store as `id-tracker:playlist-sync`.

**Pending rename**:
The state where YouTube's current title differs from the one Steve set —
`youtube_title != title AND youtube_title != dismissed_title`. **Derived**, not stored. Surfaced as
a ⚠ on the Mix row and detail page; the modal offers accept (adopt the new title) or reject (record
it in `dismissed_title` so it stops nagging, while a genuinely *new* retitle later raises again).
A **sentinel title never raises one** (see **unavailable**).

**unavailable**:
The Mix's YouTube video is gone — the API returns the literal sentinel title `Deleted video` or
`Private video`. Sets `unavailable = 1` and **short-circuits the pending-rename flow entirely**, so
the sentinel can never be adopted as the Mix's name. The Mix keeps the name Steve gave it and the
UI marks it as no longer on YouTube.

---

## 2. Data Model

```sql
-- One row per mix. Identity is url_key, never the title.
CREATE TABLE id_tracker_mixes (
  id                INTEGER PRIMARY KEY,
  url_key           TEXT    NOT NULL UNIQUE,  -- 'youtube:aB3xY' | 'soundcloud:/u/set' | 'manual:slug'
  url               TEXT,                     -- NULL for a mix that has no link at all
  source            TEXT    NOT NULL,         -- 'youtube' | 'manual'
  title             TEXT    NOT NULL,         -- Steve's name for it; only he changes it
  youtube_title     TEXT,                     -- last title seen from the API; never displayed as the name
  dismissed_title   TEXT,                     -- a youtube_title Steve rejected; suppresses the ⚠ for that string
  youtube_video_id  TEXT,                     -- 11-char id, NULL for non-YouTube
  playlist_id       TEXT,                     -- which configured playlist it came from
  duration_s        INTEGER,                  -- from videos.list; enables timestamp validation
  in_playlist       INTEGER NOT NULL DEFAULT 1,
  unavailable       INTEGER NOT NULL DEFAULT 0,
  archived_at       INTEGER,                  -- soft delete; NULL = active. Sync never clears it.
  added_to_playlist_at INTEGER,               -- snippet.publishedAt = when added to the playlist
  playlist_synced_at   INTEGER,
  created_at        INTEGER NOT NULL
);

-- One row per ID. Many per mix.
CREATE TABLE id_tracker_cues (
  id            INTEGER PRIMARY KEY,
  mix_id        INTEGER NOT NULL REFERENCES id_tracker_mixes(id) ON DELETE CASCADE,
  position_s    INTEGER NOT NULL,             -- seconds; HH:MM:SS is display/input only
  end_position_s INTEGER,                     -- optional; defines the ID's range (V2 clipping reads it)
  artist        TEXT,
  title         TEXT,
  remixer       TEXT,
  notes         TEXT,
  identified    INTEGER NOT NULL DEFAULT 0,   -- DERIVED on every write: artist AND title non-empty
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- No per-widget runs table. Sync runs are recorded through the SHARED job-run store
-- (`apps/server/src/lib/job-runs.ts`, PD-442 / D-074) via `recordRun`, under the namespaced
-- job name `id-tracker:playlist-sync` — the same convention Buy/Sell/Trade follows. Music
-- Tracker's own `music_tracker_runs` table predates that store and is the superseded pattern.
```

`position_s` is an INTEGER for three reasons: root PROJECT.md §5 mandates numeric time; it sorts
and does arithmetic correctly; and it is exactly what a YouTube deep link needs
(`?v=<id>&t=2535s`), so jumping to a Cue is a link, not a re-parse.

`end_position_s` is specified now and unused in MVP — it costs one nullable column today and
saves the V2 clipping feature a migration.

---

## 3. Playlist sync

**Config is a list, not a single id.** The source playlist is named by year ("2025 Great Mixes"),
so a single `YOUTUBE_PLAYLIST_ID` would need editing every January — and the previous year's mixes
would silently stop syncing. Music Tracker's spec warned about exactly this for Spotify and shipped
single anyway; this widget does not repeat it.

**Access is a plain API key** — the playlists are public. `playlistItems.list` costs 1 unit per page
of 50 against a 10,000/day quota, so quota is a non-issue; a second `videos.list` call (also 1 unit
per 50) fetches `duration_s`.

**Error taxonomy is worded, not generic.** The API cannot distinguish a private playlist from a
deleted one — both return `404 playlistNotFound` to an API key. So:

| Condition | Message |
|---|---|
| `404 playlistNotFound` | "Playlist no longer visible with an API key — it may have been made private or deleted. A private playlist requires OAuth." |
| `403 quotaExceeded` | "YouTube API quota exhausted for today; sync will resume tomorrow." |
| `400 keyInvalid` | "YOUTUBE_API_KEY is invalid or expired." |

**Reconciliation rules:**

1. New video → create a Mix, `title` seeded from the YouTube title.
2. Retitled video → update `youtube_title` only. The display `title` never moves without Steve.
   Raises a **pending rename** ⚠.
3. Sentinel title (`Deleted video` / `Private video`) → set `unavailable = 1`, keep the stored
   title, **do not** raise a rename.
4. Video no longer in the playlist → `in_playlist = 0`. Never delete; the Cues are the work.
5. Any page of a playlist errored → mark **no** removals that run, so a partial fetch can't
   mass-flag.
6. An **archived** Mix stays archived. Sync may update its fields but never clears `archived_at` —
   otherwise archiving a mix that is still in the playlist would undo itself on the next run.

---

## 4. Render model

The render never blocks on YouTube. `GET /mixes` always reads SQLite and returns immediately; if
`playlist_synced_at` is older than the TTL (start at 15 minutes) it fires the sync in the
background and returns cached rows anyway. A cron job runs on the same 12-hour cadence as Music
Tracker's `spotify_poll`, and a **Sync now** button covers "I added it to the playlist 10 seconds
ago" — which is the real workflow: hear a mix you like, add it to the playlist, expect it in the
widget.

Rejected: syncing on every render. Not for quota — for failure coupling (a YouTube 500 would break
the card, not slow it), double-firing (this widget registers as both an embedded card and a full
page), latency in front of local data, and the absence of any run record.

An in-memory in-flight guard prevents two near-simultaneous renders both kicking off a sync.

---

## 5. UI

**Mix-centric, not cue-centric.** IDs are almost always entered while listening to one mix, so they
are grouped under that mix rather than pooled into a cross-mix queue. (A cue-centric front page was
considered and rejected: it optimises for reviewing, which is the rarer activity.)

Follows three established conventions: one component `$lib/IdTracker.svelte` with
`variant: 'widget' | 'page'` and a five-line route wrapper; **no card flip** — [[D-062]] retired
it, so the card header links to the page; and **registration says nothing about placement**
([[D-073]]) — the registry entry carries no `pages` field, because page membership is user state.
The widget appears in the widget library and is added to a page from the UI.

**Page** — a list of Mixes, **`added_to_playlist_at DESC`** so a just-added mix is in first
position. Each row carries: title (with the ⚠ pending-rename affordance and an "unavailable"
marker), source, duration, ID count. A row expands to a nested **IDs** section listing its Cues in
`position_s` order, each showing `HH:MM:SS` as a **link straight to that moment**
(`youtu.be/<id>?t=<position_s>`), artist/title/remixer, and notes. An **Add timestamp** button sits
in that section and **stays available after each save**, so logging several in a row is not several
navigations.

Default filter hides **archived** mixes; a toggle reveals them for restore.

**Card** (embed, `cols: 2, rows: 2`): open-ID count as the headline, the most recent mixes with
open IDs, and **Sync now**. Nothing else — management lives on the page.

### Cue entry rules

**One parse rule: the rightmost field is always seconds.** `SS` / `MM:SS` / `HH:MM:SS` are the same
parse, not three cases — `42` is 42 seconds. Predictable beats clever.

- A value >59 in any non-leading field is **rejected**, not normalised (`1:75` is a typo far more
  often than shorthand for 135s).
- Pasting a YouTube URL carrying `t=` **fills the timestamp** — and, for an untracked mix, the URL
  field too. Accept `t=2535`, `t=2535s`, and `t=1h30m15s`; YouTube emits all three.
- `position_s > duration_s` is **rejected** when duration is known (the 1:47:30-on-a-62-minute-mix
  case). No validation when duration is unknown.
- `0:00` is valid — something can be playing as the mix opens.
- Two Cues at the **exact same** `position_s` on one Mix: **allowed, with a warning** (usually
  double-logging). Near-but-different positions are a normal blend and warn about nothing.

---

## 6. Configuration

```
YOUTUBE_API_KEY=
YOUTUBE_PLAYLIST_IDS=PLxxxx,PLyyyy    # comma-separated; append a new one each January
```

Both optional: unset, the widget logs one line and no-ops the sync. Manual mixes, cues, and the
whole UI still work — same graceful-degradation posture as Buy/Sell/Trade's Reddit credentials.

---

## 7. Operational notes (not features)

**Archive is the only removal concept.** There is no delete — the board's `archivedAt` vocabulary
already means "hidden, recoverable, still in the DB", and that is exactly the behaviour wanted. No
button destroys a Mix, because its Cues are hand-typed work.

**The first-import cleanup is a one-off, done programmatically.** After the initial sync the
playlists yield ~180 Mixes with no Cues; those get archived in a single scripted pass, once. It
needs no UI: `archived_at` survives sync (rule 6), so they never come back. A standing
"archive all cue-less mixes" button was considered and rejected — it would also archive the mix
added to the playlist ten minutes ago, which is the core workflow.

**Seeding the existing IDs is done by hand through the UI.** There are only a handful, and entering
them one at a time is a deliberate first test of the entry flow. No importer, no seed script — and
therefore no fuzzy title-matching of notes to Mixes, which was the largest single risk in the plan.

---

## 8. Out of scope (V2)

- **Embedded player.** Embed the mix in the page where the video allows it, and make a Cue's
  timestamp **seek the embedded player** rather than opening YouTube in a new tab. (The plain deep
  link is MVP — it's an `<a href>` over data we already store.)
- **Clip and download.** Export the audio at a Cue for a fixed length, or to `end_position_s` when
  set, as a file to post on Reddit ID threads. Needs an extraction tool and an egress path, so it is
  a substantial piece of work rather than a UI addition — and `end_position_s` already exists in the
  schema to receive it.
- **Handoff to Music Tracker.** Once a Cue is `identified`, push it into `music_tracker_tracks` as a
  wanted track so the existing library matcher and acquisition flow take over. Deliberately
  deferred: this widget's job is *what is it*, Music Tracker's is *do I have it*. The schema above
  already carries `artist`/`title`/`remixer` in the shape Music Tracker's manual-entry route wants,
  so V2 needs no migration.
- A `lead` field (where an identification came from — a comment, 1001tracklists). `notes` absorbs
  this until real use shows it needs structure.
- An `abandoned` status for IDs given up on.
- Audio fingerprinting to identify a Cue automatically.
