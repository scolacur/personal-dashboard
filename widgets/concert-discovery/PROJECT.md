# Concert Discovery — PROJECT.md

A feed of upcoming shows from artists the user follows on Resident Advisor, filtered to events near a configured location. The goal is a single view of "what's coming up that I might want to go to" without having to check RA manually.

See also: [TODO.md](TODO.md)

---

## 1. MVP Scope

- User maintains a list of RA artist slugs in the widget (e.g. `objekt`, `call-super`, `blawan`)
- Backend queries the RA GraphQL API for upcoming events per artist, caches results in SQLite
- Frontend shows a chronological feed: date, artist, event title, venue, city — each linking out to the RA event page
- Events filtered to a configured location radius (city name + country via env var)
- Cron polls every 6 hours
- Manual "refresh now" button
- No RA account auth required — querying public artist event pages only

### Explicitly NOT in MVP

- Pulling the user's existing RA follows list automatically (requires RA account auth — deferred)
- Custom artist list for artists not on RA
- Songkick or other sources
- Social media / tour page scraping
- "Interested" / "going" tracking
- Calendar export

---

## 2. RA API

Resident Advisor exposes an unofficial GraphQL API at `https://ra.co/graphql` — this is what the RA website itself uses, not a documented public API. It has no API key requirement for public artist/event queries, but it is subject to change without notice.

Key queries needed:

- Look up artist by slug → get internal RA artist ID
- Fetch upcoming events for an artist ID, filtered by area/date

**Risk:** unofficial APIs can break. If RA changes their schema or adds auth requirements, this widget breaks. Worth monitoring but acceptable for a personal tool. See TODO.md for mitigation options.

**Location filtering:** RA's event queries accept an `areas` parameter (RA area IDs — e.g., New York is area 13, London is area 1). The configured city will need to be mapped to an RA area ID. A small lookup table of common cities → RA area IDs is the simplest approach; it can be expanded manually.

---

## 3. Data Model

```sql
-- Artists being tracked
CREATE TABLE concert_discovery_artists (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  ra_slug TEXT NOT NULL UNIQUE,  -- e.g. 'objekt', 'call-super'
  ra_id TEXT,                    -- internal RA ID, fetched on first lookup and cached
  active INTEGER NOT NULL DEFAULT 1,
  added_at INTEGER NOT NULL,
  last_fetched_at INTEGER
);

-- Cached upcoming events
CREATE TABLE concert_discovery_events (
  id INTEGER PRIMARY KEY,
  artist_id INTEGER REFERENCES concert_discovery_artists(id) ON DELETE SET NULL,
  artist_name TEXT NOT NULL,     -- denormalized; artist may be removed later
  event_title TEXT NOT NULL,
  venue TEXT,
  city TEXT,
  country TEXT,
  event_date INTEGER NOT NULL,   -- unix ms (start of event)
  event_url TEXT,                -- RA event page URL
  source TEXT NOT NULL DEFAULT 'ra',
  source_ref TEXT,               -- RA event ID
  fetched_at INTEGER NOT NULL,
  UNIQUE(source, source_ref)
);
```

---

## 4. Backend

### Routes (all under `/api/widgets/concert-discovery`)

- `GET  /events?days=60` — upcoming events within the next N days, chronological, location-filtered
- `GET  /artists` — list tracked artists
- `POST /artists` — add artist: `{ name, raSlug }` — backend fetches and caches RA ID
- `DELETE /artists/:id` — remove artist (and cascade-delete their cached events)
- `POST /jobs/refresh` — manually trigger a full fetch for all active artists

### Cron

- `concert_discovery_refresh` — every 6 hours: fetch events for all active artists, upsert results, prune events with `event_date < now`

### Configuration (env vars)

```
CONCERT_DISCOVERY_CITY=New York     # display label
CONCERT_DISCOVERY_RA_AREA_ID=13    # RA area ID for location filtering
CONCERT_DISCOVERY_LOOKAHEAD_DAYS=60 # how far ahead to fetch events
```

---

## 5. Frontend

```
┌──────────────────────────────────────────────┐
│  UPCOMING SHOWS              [+ Add Artist]  │
│                                              │
│  SAT JUN 7                                   │
│  Objekt · Fabric · London          [↗ RA]   │
│                                              │
│  FRI JUN 13                                  │
│  Blawan · De School · Amsterdam    [↗ RA]   │
│  Call Super · fabric · London      [↗ RA]   │
│                                              │
│  ...                            [Refresh ↺] │
└──────────────────────────────────────────────┘
```

Artist management (via wrench settings panel):

- List of tracked slugs with remove buttons
- Input field + Add button: user types the RA slug (visible in the RA artist URL: `ra.co/dj/<slug>`)

---

## 6. Open Questions

- RA area IDs need to be looked up manually — what's the right area ID for the user's city? (Needs to be set in env before first run.)
- Should events without a matching configured area still show (just without location filtering), or be hidden entirely?
- If the same event features multiple tracked artists, should it appear once or once per artist?
