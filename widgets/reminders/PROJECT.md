# Reminders — PROJECT.md

A minimal reminder widget. Set a date/time and a note; when the time arrives the widget surfaces the reminder prominently with Clear and Snooze buttons. Designed to be usable from mobile and, eventually, with voice input.

See also: [TODO.md](TODO.md)

---

## 1. MVP Scope

- Form: date/time picker + note text input + Submit
- Upcoming reminders list (toggled view)
- When a reminder fires: the widget switches to an alert state — reminder note displayed large, **Clear** and **Snooze** buttons prominent
- Snooze adds 10 minutes and re-queues (snooze duration not configurable in MVP)
- Browser `Notification` API alert fires alongside the in-widget alert (requires user to grant notification permission once)
- Frontend polls `/api/widgets/reminders/due` every 30 seconds to check for fired reminders
- Mobile-first layout: large touch targets for Clear/Snooze, form usable on a small screen
- SQLite table namespaced `reminders_*` in the shared DB

### Explicitly NOT in MVP

- Voice input (future — see TODO.md)
- Natural language date parsing ("remind me tomorrow at noon") — structured date/time picker only
- Recurring reminders
- Categories or priority levels
- Push notifications via Service Worker (polling + Browser Notifications is sufficient for an always-open dashboard tab)

---

## 2. Data Model

```sql
CREATE TABLE reminders_items (
  id INTEGER PRIMARY KEY,
  note TEXT NOT NULL,
  remind_at INTEGER NOT NULL,             -- unix ms; updated on each snooze
  original_remind_at INTEGER NOT NULL,    -- unix ms; never changes, for display
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'cleared'
  snooze_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  cleared_at INTEGER                      -- unix ms; NULL until cleared
);
```

State machine: `pending` → fires when `remind_at <= now` → user hits **Clear** (status = `cleared`) or **Snooze** (`remind_at += chosen_duration`, `snooze_count++`, status stays `pending`).

---

## 3. Backend

### Routes (all under `/api/widgets/reminders`)

- `GET  /` — list reminders; `?status=pending` for upcoming, default returns all non-cleared
- `GET  /due` — returns all `status='pending'` reminders where `remind_at <= now` (polled by frontend)
- `POST /` — create: `{ note: string, remindAt: number }` (unix ms)
- `POST /:id/clear` — mark cleared, set `cleared_at`
- `POST /:id/snooze` — `{ minutes: 5 | 10 | 30 | 60 }` — `remind_at = now + minutes`, `snooze_count++`
- `DELETE /:id` — hard delete (for removing upcoming reminders before they fire)

No cron jobs needed — delivery is handled by frontend polling.

---

## 4. Frontend

### Normal state (no active alerts)

```
┌──────────────────────────────────────────┐
│  REMINDERS                  [Upcoming ▾] │
│                                          │
│  Note: [                              ]  │
│  When: [date ───────] [time ──]          │
│                              [+ Add]     │
└──────────────────────────────────────────┘
```

Upcoming toggle expands a list below the form:

```
  → Thu May 28, 9:00 AM — Call dentist      [✕]
  → Fri May 29, 2:00 PM — Check laundry     [✕]
```

### Alert state (one or more reminders due)

The widget takes over its card with the alert. If multiple are due, cycle through them one at a time.

```
┌──────────────────────────────────────────┐
│  ⏰ REMINDER                             │
│                                          │
│        Call dentist                      │
│     Originally: Thu May 28, 9:00 AM      │
│        (snoozed 1×)                      │
│                                          │
│  Snooze: [5m]  [10m]  [30m]  [1h]       │
│   [          Clear         ]             │
└──────────────────────────────────────────┘
```

---

## 5. Mobile Considerations

- Form fields must be large enough to tap accurately on a phone screen
- The alert state especially should use full-card coverage with big buttons — this is the primary mobile interaction
- Date/time input: use native `<input type="datetime-local">` which gives the platform's native picker (works well on iOS Safari and Android Chrome)
- The dashboard is currently LAN-only, but the user intends to expose it via reverse proxy for mobile access — design for that from the start

---

## 6. Open Questions

- If multiple reminders fire at once, should they stack (dismiss one at a time) or show a list?
- Browser Notification permission: prompt once on first load of this widget, or only when the user adds their first reminder?
