# Mood & Energy — PROJECT.md

A mobile-first widget for one check-in a day: how I feel (mood 1–5), how much energy I have
(energy 1–5), feeling tags and a free-text note.

Built by PD-95 (Mood & Energy widget).

---

## 1. Scope

- **One entry per day.** The day is the **habit day**: `habitDay(instant, settings)` with the
  **Habit Tracker's settings** (day boundary + timezone, from the shared habit store, D-092). A
  check-in at 1am counts toward the previous day. Saving again for a day **updates** it.
- **Capture**, at `/widgets/mood-energy` (Log tab), top to bottom: "Today (Tue 24 Nov) ▾" date
  override (to backfill a missed day) → "Editing today" when the day already has an entry → mood
  (big value, rubric word, horizontal slider) → energy (same) → feeling-tag cloud → note → **Save**.
  - Both sliders start at **3** for a new day. If the day already has an entry, the form loads it.
  - After Save: a "Saved <weekday>" toast; the form keeps showing the saved day; a backfill returns
    to today.
- **Rubrics** (`MOOD_RUBRIC`, `ENERGY_RUBRIC` in `@dashboard/shared`):
  - Mood: 1 Unpleasant · 2 Slightly Unpleasant · 3 Neutral · 4 Pleasant · 5 Very Pleasant.
  - Energy: 1 Drained · 2 Low · 3 Steady · 4 Energized · 5 Very Energized.
- **Colours**: mood uses the shared red→green 1–5 scale (`SCALE_1_5_COLORS`, also the Sleep
  Journal's rested colours). Energy uses its own single-hue ramp, dim slate → bright blue
  (`ENERGY_COLORS`), so the two never read as each other. Both are mid-tone with dark ink.
- **Feeling tags**: on/off, "+ custom", "edit" mode hides one (page only). Past entries keep a
  hidden tag, and naming it again brings it back. Seeded: calm, anxious, irritable, focused, sad,
  grateful.
- **Log tab** below the capture: a **week calendar** (Mon–Sun rows, newest week at the bottom,
  month gutter, earlier weeks load on scroll or "Earlier weeks"). Each day is shaded by mood with an
  energy bar along the bottom (width = energy). Tapping a day opens it in a dialog — edit, delete, or
  log an empty day. Then a list of days, newest first (mood and energy words, tags, note snippet),
  which opens the same dialog.
- **Trends tab**: a 7d / 30d / 90d / All range (default 30d) above every view.
  - **Averages**: mean mood, mean energy, days logged.
  - **Over time**: daily mood (solid) and energy (dashed) lines on a 1–5 scale. Tap a day for its
    values. Hand-drawn SVG; no chart dependency.
  - **Mood by feeling**: per tag, average mood on days with it (bar) vs. without (tick).
  - **Mood by weekday**: Mon–Sun average mood.
  - Groups with fewer than 5 days (`MIN_N`) are faded and marked "too few to tell". All arithmetic
    is in `stats.ts`, unit-tested.
- **Dashboard card**: the capture (two compact sliders, tags, a one-line note, Save). No history,
  tag editing or date override.
- **Offline**: every save (capture and the calendar dialog) goes through the shared outbox
  (`$lib/outbox`) and shows "N pending sync" while lagging. Unsynced saves are folded over the
  server's days, so the calendar, list and trends show them at once. The habit settings are cached
  on the device so "today" is right offline; without a cache the shared defaults (04:00,
  America/New_York) apply.

### Known limits

- A day whose only save is still in the outbox can't be deleted until it syncs.
- As with the Tinnitus Tracker, opening the page cold with no signal fails (no service worker).
- The card names its day from `recordedAt` on the server; at the day boundary, a form loaded at
  3:59 and saved at 4:01 saves to the new day.

---

## 2. Data model

Own tables (`mood_energy_*`), with the day as the natural key.

```sql
mood_energy_tags        (id, name UNIQUE NOCASE, hidden_at, created_at)
mood_energy_entries     (id, day UNIQUE, recorded_at, mood 1–5, energy 1–5, note, created_at, updated_at)
mood_energy_entry_tags  (entry_id → entries ON DELETE CASCADE, tag_id → tags)
mood_energy_client_ids  (client_id PK, entry_id → entries ON DELETE CASCADE, created_at)
```

- `day` is `YYYY-MM-DD`, the habit day. `recorded_at` is unix ms of the **last save**.
- **Client ids**: generated on the phone for every save. Because a day is updated in place, one
  entry collects many client ids, so they live in their own table; a replay of *any* of them —
  even an older save after a newer one — returns the current row unchanged.
- On the wire, entries carry tag **names**. The server creates unknown names and un-hides hidden
  ones, so a custom tag added offline still syncs.

## 3. API — `/api/widgets/mood-energy`

| Method | Path | |
|---|---|---|
| GET | `/tags` | visible tags |
| POST | `/tags` `{name}` | create, or un-hide an existing tag |
| DELETE | `/tags/:id` | hide (soft) |
| GET | `/entries?since=&until=&limit=` | newest day first; `since`/`until` are days, inclusive (default limit 60 without a range, max 5000) |
| GET | `/entries/day/:day` | `{ entry }`, null when the day has none |
| POST | `/entries` `{clientId, recordedAt, day?, mood, energy, tags[], note?}` | upsert by day. 201 when the day was new; 200 when it updated the day or replayed a known `clientId` |
| PATCH | `/entries/:id` `{mood?, energy?, tags?, note?}` | partial update; `tags` replaces the set; `recordedAt` becomes now |
| DELETE | `/entries/:id` | hard delete |

**Day**: without `day`, the server derives it from `recordedAt` and the habit settings. With one
(a backfill), it must be a real date no later than today's habit day.

**Validation** (400 with a `code`): mood/energy whole numbers 1–5; `recordedAt` unix ms, at most
5 min ahead of the server clock; note ≤ 2000 chars (trimmed; empty → null); tag names normalised
(trimmed, whitespace collapsed, lowercased), non-empty, ≤ 32 chars.

The client reads the habit settings from `GET /api/habits/settings`.
