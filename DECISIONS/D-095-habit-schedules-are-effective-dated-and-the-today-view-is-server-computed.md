# D-095: Habit schedules are effective-dated rows, and due/streak are pure shared functions computed in a server Today view

**Date:** 2026-11-17
**Ticket:** PD-722 (Habit Tracker — schedules, streaks, extras) · **Extends:** [[D-092]] (habits are a shared store in `apps/server/src/lib/`) · **Related:** `widgets/habit-tracker/PROJECT.md` §2/§5, root `PROJECT.md` §9 (Habit Tracker glossary)

## Context

PD-721 shipped daily-only habits. This slice adds schedules (days-of-week and N-per-week),
streaks and extras. Three shapes had to be settled: how a schedule change avoids rewriting
history, where the due/streak logic lives, and how the client gets a per-item streak without
holding the full completion history the computation needs.

## Decision

1. **Schedules are effective-dated rows in `habit_schedules`.** Each row applies from its
   `effective_from_day`; the row in force on a day is the latest one whose `effective_from_day <= day`.
   A change inserts (or, for a same-day re-edit, upserts via `UNIQUE(item_id, effective_from_day)`)
   a row starting **today** and never touches a past row. So history is always judged by the schedule
   that applied then (the Mon/Wed/Fri → Tue/Thu test). A habit with no row is treated as daily.

2. **All due/streak/progress logic is pure and lives in `@dashboard/shared`** (`isDue`,
   `perWeekProgress`, `streak`, `scheduleForDay`, calendar helpers). It is unit-tested there (run
   from the server's vitest, as `habitDay` already is — the shared package has no runner). This is
   the same split D-092 set up: shapes and pure functions shared, storage in `lib/`.

3. **The weekday mask is Monday-indexed** (bit 0 = Mon … bit 6 = Sun), to match the Mon–Sun habit
   week in the glossary. The default mask is all seven bits ("every day").

4. **The Today surface is a server-computed view** (`GET /api/habits/today` → `getTodayView`).
   The server owns full completion history, so it computes each active item's schedule-in-force,
   due state, per-week progress and current/longest streak in one payload rather than shipping the
   history the client would otherwise need. The client stays thin, and "today" matches the server's
   `habitDay` (D-092). After an optimistic tick the client re-fetches the view to refresh the
   streak/progress figures the tick changed.

## Alternatives rejected

**A. Mutate a single schedule row in place on change.** Simplest storage, but it rewrites history —
a past Wednesday would retroactively look not-due after switching to Tue/Thu. The effective-dated
table is the whole point.

**B. Compute streaks on the client from a fetched history window.** Keeps ticks fully optimistic,
but needs an unbounded (or arbitrarily capped) history download for `longest`, and duplicates the
server's day math. Server-side keeps it exact and small; the only cost is a re-fetch after a tick.

**C. Store streaks.** Denormalised and fast to read, but every past-day edit (the Log fixes days)
would have to recompute and the stored value would drift. Streak is cheap to derive on demand.

## Consequences

- Later slices (sets PD-723, metrics PD-724, the Log PD-725/726) read schedules through the same
  `lib/habits.ts` accessors and the shared pure functions; nothing re-implements due/streak.
- `getTodayView` reads all completions to compute `longest`; fine at personal scale, revisit only if
  history grows large.
- The per-week streak uses the target `N` in force on each week's Monday; a mid-week `N` change is a
  documented simplification, not exercised by the current tests.
