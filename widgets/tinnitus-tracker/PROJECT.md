# Tinnitus Tracker — PROJECT.md

A mobile-first widget for logging how loud tinnitus is (0–10) at a moment in time, with tags for
likely contributors (weed, caffeine, alcohol, custom) and free-text notes.

Epic: PD-704 (Tinnitus Tracker Widget). Built by PD-705 (Build the capture widget). Charts and
correlations: PD-706 (Chart + correlation views).

---

## 1. Scope

- **Capture**, at `/widgets/tinnitus-tracker`, top to bottom: tag cloud → large value label →
  large vertical slider (whole numbers 0–10, drag up to raise, **always starts at 0**) → notes →
  optional "Now ▾" time override to backdate → **Enter**.
- **Rubric label** (PD-711) sits under the value and updates as the slider moves:
  1–2 Faint · 3 Noticeable & maskable · 4 Noticeable & not maskable · 5 Distracting ·
  6 Very Distracting · 7 Painful · 8 Very Painful · 9 Debilitating · 10 Unbearable. 0 has no label.
  The rubric lives in `@dashboard/shared` (`TINNITUS_RUBRIC`) so charts can reuse it.
- **Tags** toggle on/off per entry; there are no quantities (put amounts in notes). Custom tags
  persist in the cloud. "edit" mode hides a tag; past entries keep it, and naming it again brings
  it back.
- **After Enter**: tags, notes and the time override clear. The slider stays where it was.
- **History**: recent entries below; tap one to edit (value, tags, time, notes) or delete it.
- **Dashboard card**: the same capture, without notes, backdating or history.
- **Offline**: every Enter goes through a localStorage outbox (`queue.ts`) and syncs when the
  server is reachable, retrying on `online`, on tab focus, and every 20 s. A "N pending sync" line
  shows meanwhile. Off-LAN reach itself is Tailscale (D-030 — off-LAN access via the Tailscale tailnet).

### Known limits

- The outbox only helps once the page is loaded. Opening the page cold with no signal fails,
  because there is no service worker or PWA cache. That would be a follow-up if it bites.
- Queued entries can't be edited until they sync.

---

## 2. Data model

Own tables, because an entry is an event and there can be many per day. They don't belong in the
one-row-per-day shared daily-log store (D-090 — the daily log is one shared domain store).

```sql
tinnitus_tracker_tags        (id, name UNIQUE NOCASE, hidden_at, created_at)
tinnitus_tracker_entries     (id, client_id UNIQUE, recorded_at, intensity 0–10, notes, created_at, updated_at)
tinnitus_tracker_entry_tags  (entry_id → entries ON DELETE CASCADE, tag_id → tags)
```

- `recorded_at` is unix ms, the moment the reading describes. It may be up to 5 min in the future
  to allow for phone clock drift.
- `client_id` is generated on the phone, so the outbox can replay an entry safely: POST is
  idempotent on it. `crypto.randomUUID` is unavailable over plain http, so the id falls back to
  time plus randomness.
- On the wire, entries carry tag **names**. The server creates unknown names and un-hides hidden
  ones. That is what lets a custom tag added offline still sync.

## 3. API — `/api/widgets/tinnitus-tracker`

| Method | Path | |
|---|---|---|
| GET | `/tags` | visible tags |
| POST | `/tags` `{name}` | create, or un-hide an existing tag |
| DELETE | `/tags/:id` | hide (soft) |
| GET | `/entries?limit=` | newest first by `recordedAt` (default 50, max 500) |
| POST | `/entries` `{clientId, recordedAt, intensity, tags[], notes?}` | 201 when new, 200 when replayed |
| PATCH | `/entries/:id` | partial update; `tags` replaces the whole set |
| DELETE | `/entries/:id` | hard delete |
