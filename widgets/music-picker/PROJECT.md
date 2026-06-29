# Music Picker — PROJECT.md

An interface for choosing what to listen to for the day. Three sections in one widget: an embedded Spotify playlist, a radio station browser/player, and a feed of new releases from followed Bandcamp artists.

See also: [TODO.md](TODO.md)

---

## 1. MVP Scope

### Section 1: Spotify Morning Playlist Embed

- Spotify iframe embed of a single configured playlist
- No Spotify SDK required — the standard embed player handles playback
- Playlist ID configured via env var (`MUSIC_PICKER_SPOTIFY_PLAYLIST_ID`)
- Pure frontend — no backend routes needed for this section

### Section 2: Radio Widget

- Search bar wired to the [Radio Browser API](https://api.radio-browser.info/) — free, no auth, returns stream metadata including direct stream URLs
- Results list: click any station to play via an HTML5 `<audio>` element
- Starred stations list: persisted in SQLite, always shown at top
- Pre-starred on first run: **WFMU**, **NTS**, **Rinse.fm** (seeded by backend bootstrap)
- Only one station plays at a time; clicking a new one stops the current stream

### Section 3: Bandcamp New Releases

- User maintains a list of followed Bandcamp artists (added via a small management UI in this widget's settings panel)
- Backend polls each artist's RSS feed (`https://artistname.bandcamp.com/feed`) on a cron schedule (every 12 hours)
- New releases cached in SQLite; frontend shows releases from the past 30 days, newest first
- Each release links out to its Bandcamp page
- **Note:** Bandcamp has no public API — RSS feed polling is the only clean path. Requires the user to know their artists' Bandcamp slugs.

### Explicitly NOT in MVP

- Bandcamp collection sync (only followed artists via manual list)
- Spotify Web Playback SDK integration (SDK requires Premium and adds complexity; iframe embed is sufficient)
- Radio station favorite grouping / categories
- NTS or Rinse.fm dedicated embeds (Radio Browser API covers them as stream URLs)
- Easy UI for adding / removing sources

---

## 2. Data Model

```sql
-- Radio stations (from Radio Browser API, saved when starred)
CREATE TABLE music_picker_stations (
  id INTEGER PRIMARY KEY,
  station_uuid TEXT NOT NULL UNIQUE,  -- Radio Browser API stable UUID
  name TEXT NOT NULL,
  stream_url TEXT NOT NULL,
  homepage TEXT,
  favicon_url TEXT,
  tags TEXT,                          -- comma-separated from API
  country TEXT,
  starred INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Bandcamp artists the user follows
CREATE TABLE music_picker_bandcamp_artists (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  bandcamp_url TEXT NOT NULL UNIQUE,  -- https://artistname.bandcamp.com
  feed_url TEXT NOT NULL,             -- https://artistname.bandcamp.com/feed
  active INTEGER NOT NULL DEFAULT 1,
  added_at INTEGER NOT NULL,
  last_fetched_at INTEGER
);

-- Cached releases from RSS feeds
CREATE TABLE music_picker_bandcamp_releases (
  id INTEGER PRIMARY KEY,
  artist_id INTEGER NOT NULL REFERENCES music_picker_bandcamp_artists(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  release_url TEXT NOT NULL UNIQUE,
  image_url TEXT,
  released_at INTEGER,                -- unix ms from RSS pubDate; NULL if not present
  fetched_at INTEGER NOT NULL
);
```

---

## 3. Backend

### Routes (all under `/api/widgets/music-picker`)

- `GET  /stations/search?q=...` — proxy to Radio Browser API search, returns station list
- `GET  /stations/starred` — list starred stations
- `POST /stations/star` — `{ stationUuid, name, streamUrl, ... }` — save and star a station
- `DELETE /stations/:id/star` — unstar (keep row, set `starred=0`)
- `GET  /bandcamp/artists` — list followed artists
- `POST /bandcamp/artists` — add artist: `{ name, bandcampUrl }` (backend derives `feed_url`)
- `DELETE /bandcamp/artists/:id` — remove artist
- `GET  /bandcamp/releases?days=30` — recent releases across all artists
- `POST /jobs/bandcamp-poll` — manually trigger RSS fetch for all artists

### Cron

- `bandcamp_poll` — every 12 hours: fetch RSS for all active artists, upsert releases

---

## 4. Frontend Layout

Three sections stacked vertically (or switchable via tabs — TBD):

```
┌─────────────────────────────────────────┐
│  SPOTIFY MORNING PLAYLIST               │
│  [Spotify iframe embed]                 │
├─────────────────────────────────────────┤
│  RADIO                                  │
│  [Search bar          ]  [🔍]           │
│  ▶ WFMU                    ★ (starred)  │
│  ▶ NTS Radio               ★           │
│  ▶ Rinse.fm                ★           │
│  ─ search results ─                     │
│  ▶ [result station]      ☆             │
├─────────────────────────────────────────┤
│  NEW FROM BANDCAMP                      │
│  Artist Name — Release Title   [2d ago] │
│  Artist Name — Release Title   [5d ago] │
│  ...                                    │
└─────────────────────────────────────────┘
```

---

## 5. Configuration

```
MUSIC_PICKER_SPOTIFY_PLAYLIST_ID=...   # Spotify playlist ID for the morning embed
```

---

## 6. Open Questions

- Should the three sections be stacked (one long widget) or tabbed (compact widget)? Stacked for now.
- Radio Browser API returns HTTPS stream URLs for most stations but some are HTTP-only — mixed content warnings in the browser. Worth testing with WFMU, NTS, Rinse.fm specifically before committing to this approach.
- NTS has its own embeddable player (`https://www.nts.live/embeds/...`) and Rinse.fm streams directly — both should work via Radio Browser stream URLs, but worth confirming stream quality vs. their native embeds.
- Which page does this widget live on? Candidates: Home (it's a daily routine thing), Music Discovery (thematically fits). Put it on both.
