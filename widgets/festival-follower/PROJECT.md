# Music Festival Follower — PROJECT.md

Monitors a list of music festivals for significant updates — lineup announcements, ticket on-sale dates, schedule releases — and surfaces them as a feed. Runs a nightly check so the user doesn't have to manually visit each festival site.

See also: [TODO.md](TODO.md)

---

## 1. MVP Scope

- User maintains a list of festivals with a website URL and optional RSS feed URL
- Nightly cron job checks each festival for updates via whichever method is available (RSS preferred, page change detection as fallback)
- Updates surfaced in a chronological feed: festival name, update summary, link to source
- Unseen updates visually distinguished from already-seen ones (mark as seen on click)
- Manual "check now" button per festival or for all
- SQLite tables namespaced `festival_follower_*`

### Update detection strategies (in priority order)

1. **RSS feed** — if the festival has an RSS/Atom feed, poll it for new items. Most reliable.
2. **Page change detection** — fetch the festival's news/lineup page, hash the content; if the hash changes, surface a generic "page updated — check site" alert. User clicks through to see what changed.

Strategy 1 is clean. Strategy 2 is deliberately dumb — it just tells you something changed rather than trying to extract structured data from wildly varied festival sites.

### Explicitly NOT in MVP

- Structured lineup extraction (artist names from announcement pages)
- Ticket sale price or availability monitoring
- Social media / Instagram / Twitter monitoring
- Email newsletter parsing
- Automated "what changed" diff (just flags that something changed)

---

## 2. Data Model

```sql
CREATE TABLE festival_follower_festivals (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  website_url TEXT,                     -- festival homepage or news page to watch
  rss_url TEXT,                         -- RSS/Atom feed URL if available; NULL otherwise
  location TEXT,                        -- city, country (for display only)
  start_date TEXT,                      -- YYYY-MM-DD; NULL if not yet announced
  end_date TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  added_at INTEGER NOT NULL,
  last_checked_at INTEGER,
  last_content_hash TEXT                -- hash of last fetched page content (for change detection)
);

CREATE TABLE festival_follower_updates (
  id INTEGER PRIMARY KEY,
  festival_id INTEGER NOT NULL REFERENCES festival_follower_festivals(id) ON DELETE CASCADE,
  update_type TEXT NOT NULL DEFAULT 'general', -- 'rss_item' | 'page_change' | 'general'
  title TEXT NOT NULL,
  body TEXT,                            -- RSS item body or NULL for page_change type
  source_url TEXT,                      -- link to the update or festival page
  detected_at INTEGER NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0
);
```

---

## 3. Backend

### Routes (under `/api/widgets/festival-follower`)

- `GET  /festivals` — list tracked festivals
- `POST /festivals` — add festival: `{ name, websiteUrl, rssUrl?, location?, startDate?, endDate? }`
- `PATCH /festivals/:id` — update festival details (e.g., add rss_url when found later)
- `DELETE /festivals/:id` — remove festival and its updates
- `GET  /updates?seen=false` — recent updates; `?seen=false` for unseen only
- `POST /updates/:id/seen` — mark an update as seen
- `POST /updates/seen-all` — mark all updates as seen
- `POST /jobs/check` — manually trigger check for all festivals
- `POST /jobs/check/:festivalId` — manually trigger check for one festival

### Cron

- `festival_check` — nightly (e.g., 8:00 AM): check all active festivals for updates

### Check logic (per festival)

```
if rss_url:
  fetch RSS feed
  for each item newer than last_checked_at:
    upsert update row (dedupe by guid/link)
else if website_url:
  fetch website_url
  hash content
  if hash != last_content_hash:
    insert 'page_change' update: "Something changed on [name]'s website"
    update last_content_hash
update last_checked_at
```

---

## 4. Frontend

```
┌──────────────────────────────────────────────┐
│  FESTIVAL UPDATES              [+ Festival]  │
│                                              │
│  ● Dekmantel · Lineup Phase 2 announced      │
│    "150 artists added including..."  [↗]    │
│    2h ago · Mark seen                        │
│                                              │
│  ● Sonar · Something changed on website [↗] │
│    Yesterday · Mark seen                     │
│                                              │
│  ─────────────────────────────────────────   │
│  FOLLOWING (3)                  [Manage]     │
│  Dekmantel · Aug 2026 · Amsterdam            │
│  Sonar · Jun 2026 · Barcelona                │
│  Fabric Open Air · TBA · London              │
└──────────────────────────────────────────────┘
```

- Unseen updates shown with a colored dot
- "Mark seen" per item; "Mark all seen" at top
- Manage view (settings panel): add/remove/edit festivals

---

## 5. Open Questions

- Should `page_change` updates auto-mark as seen after the user clicks the link, or require explicit dismissal?
- How to handle festivals with no RSS and no stable "news page" URL? Some festivals only post to Instagram. Flag as "no monitorable source" and surface a manual reminder instead?
- Should past festivals (end_date in the past) auto-archive, or stay in the list until manually removed?
