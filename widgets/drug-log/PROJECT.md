# Drug Log — PROJECT.md

A tap counter for what Steve's character does in a video game — not real-life use. One large round
button per drug; each tap logs one event with its timestamp. Treat it as an ordinary tap counter.

Built by PD-975 (Drug log widget — tap buttons, custom color/label, log by day and by drug).

---

## 1. Scope

- **Capture** at `/widgets/drug-log` (Buttons tab) and on the dashboard card: a grid of large round
  buttons, each with a **colour** and short **label** (≤ 12 characters; the text shrinks to fit the
  circle and is black or white, whichever contrasts more with the fill). First boot seeds one
  button, **Weed**, green.
- **Tap** logs one event at that instant: a soft press-scale plus a ring pulse in the button's
  colour (both off under `prefers-reduced-motion`), and a short `navigator.vibrate` where supported.
  Each button carries a **today** count badge.
- **Undo**: every tap shows "Logged Weed · Undo" for 5 s. Undo removes a still-queued tap from the
  outbox, or deletes the synced event. A tap undone while its send is in flight is deleted as soon
  as the send lands.
- **Day** = a **habit day** under the **Habit Tracker's settings** (day boundary + home timezone,
  from the shared habit store, D-092), so a 2am tap counts toward the evening before, and changing
  the boundary in the Habit Tracker moves it here too. Future cross-widget correlation keys on the
  same "day". The server sends the settings with `GET /drugs`; the client caches them for offline
  use and falls back to the shared defaults (04:00, America/New_York).
- **Offline**: every tap goes through the generic `$lib/outbox` with a client id; the server is
  idempotent on it. A "N pending sync" line shows while taps are queued.
- **Manage buttons** (page only): **Edit** mode on the grid. "+" adds a button (label + colour);
  tapping a button edits it — label, colour, move earlier/later, archive, delete. Delete confirms
  with the entry count ("Delete Weed and its 42 entries?") and cascades. Archived buttons leave the
  grid but keep their history; they're listed below the grid in edit mode, with Unarchive.
- **Colour picker**: the reusable `$lib/ColorPicker.svelte` — 12 presets plus a Custom hex field
  (with live preview and a native colour input). Hex normalising and contrast live in
  `@dashboard/shared` (`color.ts`).
- **Log tab**, two views (a `SegmentedToggle`, like the Habit Tracker's Log):
  - **By Day**: habit days newest first (two weeks, then "Load older days"), each with per-drug
    count chips ("Weed ×3"). A day expands to its events; each can be re-timed, moved to another
    drug, or deleted. "+" on a day adds an entry by hand.
  - **By Drug**: a dropdown (active drugs, then Archived); a Mon–Sun week calendar, newest week at
    the bottom, month gutter, earlier weeks lazy-loaded on scroll. Each cell shows the count,
    shaded in the drug's colour by how busy the day was relative to the busiest day shown. Header
    stats: total in the shown weeks, days used in the last 30, average per active day, current
    and longest streak of consecutive days, last logged ("2h ago"). Tapping a day lists its events
    below for editing.
- **Dashboard card**: the button grid with today badges and the undo toast. No editing, no log.

### Known limits

- Managing buttons and editing/adding past entries need the server; only taps are offline-safe.
- The Log shows synced events only; queued taps appear once they sync.
- Times in the Log and the edit form are in the device's local time; the day they belong to is the
  habit day in the home timezone.

---

## 2. Data model

```sql
drug_log_drugs  (id, label, color '#rrggbb', sort_order, archived_at, created_at)
drug_log_events (id, client_id UNIQUE, drug_id → drugs ON DELETE CASCADE, recorded_at, created_at, updated_at)
drug_log_meta   (key PRIMARY KEY, value)   -- 'seeded_default_drug' marker
```

- `recorded_at` is unix ms; it may be up to 5 min in the future (phone clock drift).
- Weed is seeded **once per database**: the `drug_log_meta` marker is written on first boot, so
  deleting Weed doesn't bring it back on restart. A database that already has drugs is not seeded.
- Labels are trimmed with whitespace collapsed, 1–12 characters. Colours are stored canonical
  (`normalizeHexColor`: lower-case `#rrggbb`, `#rgb` expanded).

## 3. API — `/api/widgets/drug-log`

| Method | Path | |
|---|---|---|
| GET | `/drugs` | `{ drugs, daySettings }` — every drug (archived included, with `archivedAt` and `eventCount`) in grid order, plus the Habit Tracker's day settings |
| POST | `/drugs` `{label, color}` | create at the end of the grid |
| PATCH | `/drugs/:id` `{label?, color?, sortOrder?, archived?}` | partial update |
| DELETE | `/drugs/:id` | hard delete, cascading to its events |
| GET | `/events?since=&until=&drugId=&limit=` | newest first; `since` inclusive, `until` exclusive (unix ms); limit default 500, max 10,000 |
| POST | `/events` `{clientId, drugId, recordedAt}` | 201 when new, 200 when replayed |
| PATCH | `/events/:id` `{recordedAt?, drugId?}` | re-time / re-assign |
| DELETE | `/events/:id` | hard delete |

Errors are `{ error, code }` with 400 for validation (`invalid_label`, `invalid_color`,
`invalid_recorded_at`, `unknown_drug`, …) and 404 for a missing row.
