# Concert Diary — PROJECT.md

A personal log of concerts attended. Quick entry form for the essentials (artist, venue, date, who you went with, notes), with photo/video attachment. The key feature: when you add an entry, it checks Google Photos for photos taken on that date and suggests them for auto-attachment.

See also: [TODO.md](TODO.md)

---

## 1. MVP Scope

- CRUD for concert entries: artist, venue, city, date, companions, notes
- Photo attachment: upload photos directly (stored in the server's data volume)
- Google Photos auto-suggestion: when an entry is saved with a date, backend queries Google Photos for media taken on that date (±12 hours to catch late-night shows), surfaces suggestions for the user to confirm
- Confirmed Google Photos items stored by their Google Photos ID + a cached thumbnail; full-res fetched on demand
- Entry list view: chronological (newest first), filterable by artist or year
- SQLite tables namespaced `concert_diary_*`

### Explicitly NOT in MVP

- Video upload (storage-intensive; Google Photos link is sufficient for now)
- Backfill from Workflowy, Google Calendar, or camera roll (future — see TODO.md)
- Map view
- Setlist lookup (Setlist.fm API — future)
- Duplicate detection

---

## 2. Data Model

```sql
CREATE TABLE concert_diary_entries (
  id INTEGER PRIMARY KEY,
  artist TEXT NOT NULL,
  venue TEXT,
  city TEXT,
  country TEXT,
  event_date TEXT NOT NULL,              -- YYYY-MM-DD
  companions TEXT,                       -- free text (e.g. "Alex, Sarah")
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE concert_diary_media (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES concert_diary_entries(id) ON DELETE CASCADE,
  media_type TEXT NOT NULL,              -- 'photo' | 'video'
  source TEXT NOT NULL,                  -- 'upload' | 'google_photos'
  -- for 'upload' source:
  filename TEXT,
  storage_path TEXT,                     -- path under /data/concert-diary/
  -- for 'google_photos' source:
  google_photos_id TEXT,
  google_photos_base_url TEXT,           -- cached base URL for thumbnail (expires; refreshed on access)
  -- shared:
  captured_at INTEGER,                   -- unix ms from EXIF or Google Photos metadata
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
```

---

## 3. Google Photos Integration

Uses the Google Photos Library API (OAuth2 via a stored refresh token, same credential flow as other Google integrations in this project).

### Auto-suggestion flow

1. User saves a concert entry with an `event_date`
2. Backend calls `mediaItems.search` with a date filter for that date ±12 hours
3. Results returned to frontend as "suggested photos" — user sees thumbnails and checks/unchecks
4. Confirmed items inserted into `concert_diary_media` with `source='google_photos'`

### Credential configuration

```
CONCERT_DIARY_GOOGLE_CLIENT_ID=...
CONCERT_DIARY_GOOGLE_CLIENT_SECRET=...
CONCERT_DIARY_GOOGLE_REFRESH_TOKEN=...  # one-time OAuth dance, same as other Google widgets
```

The Google Photos `baseUrl` for thumbnails expires after ~60 minutes. Backend should refresh it on access if stale (re-fetch via `mediaItems.get` using the stored `google_photos_id`).

---

## 4. Backend

### Routes (under `/api/widgets/concert-diary`)

- `GET  /entries?year=&artist=` — list entries with media counts
- `GET  /entries/:id` — single entry with full media list
- `POST /entries` — create entry: `{ artist, venue, city, country, eventDate, companions?, notes? }`
- `PATCH /entries/:id` — update entry fields
- `DELETE /entries/:id` — delete entry and cascade media
- `POST /entries/:id/media/upload` — multipart upload of a photo file
- `DELETE /entries/:id/media/:mediaId` — remove a media item
- `GET  /entries/:id/google-photos-suggestions` — query Google Photos for the entry's date, return suggested media
- `POST /entries/:id/media/attach-google-photos` — `{ googlePhotosIds: string[] }` — confirm and save suggested items

---

## 5. Frontend

### Entry list

```
┌──────────────────────────────────────────────┐
│  CONCERT DIARY              [+ Add Concert]  │
│                                              │
│  2026                                        │
│  ┌──────────────────────────────────────┐   │
│  │ 📷3  Objekt · fabric · London        │   │
│  │       May 24 · with Alex             │   │
│  └──────────────────────────────────────┘   │
│  ┌──────────────────────────────────────┐   │
│  │ 📷1  Blawan · Berghain · Berlin      │   │
│  │       Apr 5                          │   │
│  └──────────────────────────────────────┘   │
└──────────────────────────────────────────────┘
```

### Entry detail / add form

- Form fields: artist, venue, city, date, companions, notes (textarea)
- Photo grid: uploaded photos + Google Photos attachments shown together
- After save: "We found X photos from Google Photos on this date — attach them?" prompt with thumbnail grid + checkboxes

---

## 6. Open Questions

- Should video be supported at all for direct upload? Videos are large (hundreds of MB). A middle ground: store a link/reference only, not the file itself.
- ±12 hours for the Google Photos date window — is that enough for an after-midnight show? Should it be configurable per entry?
- Should entries be cross-referenced with Concert Discovery? (e.g., marking a concert as attended from the upcoming shows feed)
- One Google OAuth credential for all Google integrations, or one per widget? Better to share one credential set across the whole app (configured once, reused by all Google-touching widgets).
