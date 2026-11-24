# Sleep Journal — PROJECT.md

A mobile-first widget for logging each night: when I went to sleep and woke, how rested I feel
(1–5), dream notes, and counted tags for supplements (Magnesium ×2).

Built by PD-51 (Sleep Journal widget).

---

## 1. Scope

- **One entry per night**, keyed by the **wake date**: the local calendar date (America/New_York,
  `SLEEP_TIMEZONE`) of the wake time. Saving a night whose wake date already has an entry updates
  that entry.
- **Capture**, at `/widgets/sleep-journal` (Log tab), top to bottom: Asleep → Awake time inputs with
  the live duration ("7h 25m") → "Woke today ▾" date override, to backfill a missed night → large
  value + rubric label → large **horizontal** rested slider (whole numbers 1–5, drag right to raise,
  **always starts at 3**) → counted tag cloud → dream notes → **Save**.
  - Wake defaults to now, rounded down to 5 min. Sleep defaults to the previous night's sleep time
    of day, else 23:00. A sleep time later in the day than the wake time is the previous evening.
  - If today's wake date already has an entry, the form loads it ("Editing last night"). Saving a
    date that already has a night says so ("Saving replaces the night of …").
  - After Save: a "Saved night of <date>" toast; notes, tags, the slider and the date reset; the
    sleep time is kept.
- **Rubric** (`SLEEP_RUBRIC` in `@dashboard/shared`): 1 Wrecked · 2 Groggy · 3 Okay · 4 Solid ·
  5 Quite Rested.
- **Rested colours** (`SLEEP_RESTED_COLORS`): 1 red, 2 orange, 3 yellow, 4 light green, 5 green —
  mid-tone, with dark ink on top, so they read on both themes. The slider, calendar, list and trends
  all use them.
- **Counted tags**: tapping an off tag turns it on at ×1 and shows − / + on the chip
  ("Magnesium − 2 +"). − at 1 turns it off; tapping the name of an on chip does nothing. Counts are
  1–20. "+ custom" adds a tag; "edit" hides one; past nights keep hidden tags, and naming one again
  brings it back. Seeds: Magnesium, Ashwagandha, Melatonin. Names keep their case and match
  case-insensitively.
- **History tab**: a week calendar (Mon–Sun rows, newest week at the bottom, month names in a left
  gutter, earlier weeks loaded on scroll-up or "Earlier weeks"), each night shaded by its rested
  score; tap a night to edit it, or an empty night to log one for that date. Below it, the list of
  nights, newest first: date, sleep → wake, duration, rested, tag×count chips, notes snippet. Tap to
  edit every field or delete.
- **Trends tab**: a 7d / 30d / 90d / All range (default 30d) over: averages (duration, rested, sleep
  time, wake time), a hand-drawn SVG of nightly duration bars coloured by rested score with an
  average line, and per-tag average rested with vs. without the tag. Groups with fewer than 5
  nights (`MIN_N`) on either side are faded and marked "too few to tell". All arithmetic is in
  `stats.ts`, unit-tested. Bedtimes average across midnight (23:30 and 00:30 → 00:00).
- **Dashboard card**: the capture form (times, slider, counted tags, a two-row dream-notes box, Save).
  No history, no tag editing, no date override.
- **Offline**: every save goes through the generic outbox (`$lib/outbox`, key
  `sleep-journal:pending`) and syncs when the server is reachable; "N pending sync" shows meanwhile.
  Edits and deletes from the History tab are direct calls, as in the Tinnitus Tracker.
- **Shared UI**: the slider and tag cloud are `$lib/RangeSlider.svelte` and `$lib/TagCloud.svelte`
  (counted mode), shared with the Tinnitus Tracker. The calendar is an adapted copy of the Habit
  Tracker's By Habit calendar built on the shared week helpers in `@dashboard/shared`; lifting a
  generic week calendar into `$lib` is a follow-up.

### Known limits

- Like the Tinnitus Tracker, the outbox only helps once the page is loaded (no service worker).
- Queued nights can't be edited until they sync.

---

## 2. Data model

```sql
sleep_journal_tags           (id, name UNIQUE NOCASE, hidden_at, created_at)
sleep_journal_entries        (id, client_id UNIQUE, wake_date UNIQUE, sleep_at, wake_at, rested 1–5,
                              notes, created_at, updated_at, CHECK sleep_at < wake_at)
sleep_journal_entry_clients  (client_id PK, entry_id → entries ON DELETE CASCADE)
sleep_journal_entry_tags     (entry_id → entries ON DELETE CASCADE, tag_id → tags, count 1–20)
```

- `sleep_at` / `wake_at` are unix ms. `wake_date` is derived by the server from `wake_at`, never sent.
- A night is valid when sleep < wake, it lasts at most 24 h, and the wake time is at most 5 min in
  the future (phone clock drift).
- `client_id` is the id that created the night. Every client id that has written to a night — the
  creator and later upserts — is kept in `sleep_journal_entry_clients`, so the outbox can replay
  any of them safely: a replay returns the night as it is now and never re-applies stale values over
  a later edit.
- On the wire, tags are `{name, count}[]`. The server creates unknown names and un-hides hidden ones.

## 3. API — `/api/widgets/sleep-journal`

| Method | Path | |
|---|---|---|
| GET | `/tags` | visible tags |
| POST | `/tags` `{name}` | create, or un-hide an existing tag |
| DELETE | `/tags/:id` | hide (soft) |
| GET | `/entries?limit=&since=` | newest wake date first. Default 50, max 500; with `since` (`YYYY-MM-DD`, inclusive) max 10,000 |
| POST | `/entries` `{clientId, sleepAt, wakeAt, rested, tags[], notes?}` | upsert by wake date: 201 when a new night, 200 when it updated one or replayed a client id |
| PATCH | `/entries/:id` | partial update; `tags` replaces the whole set; 409 if it moves onto a taken wake date |
| DELETE | `/entries/:id` | hard delete |

Validation errors are 400 with a `code`: `invalid_rested`, `invalid_times`, `invalid_duration`,
`invalid_wake_at`, `invalid_sleep_at`, `invalid_notes`, `invalid_tag`, `invalid_tags`,
`invalid_count`, `invalid_client_id`.
