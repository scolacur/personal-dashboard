# D-102: By Habit completion-rate is a floored, in-progress-excluded window; Today opens the calendar from a dedicated control, not the name text

**Date:** 2026-11-20
**Ticket:** PD-726 ([Habit Tracker] Log › By Habit calendar) · **Epic:** PD-361 · **Builds on:** [[D-095]] (effective-dated schedules; streaks as pure shared functions), [[D-092]] (shared habit store), [[D-093]] (shared outbox)

## Context

The By Habit view (PROJECT.md §3) shows a per-item calendar with header stats: current streak,
longest streak, and a **completion rate over the last 30 due periods**. Two things the spec leaves
under-specified had to be settled to ship it.

1. **What exactly the completion rate counts.** "Over the last 30 due periods" needs a floor (how
   far back history reaches), a period model (days vs weeks), and a rule for the current, still-open
   period.
2. **How a Today row opens the calendar.** The ticket says "tapping an item's name on a Today row …
   opens By Habit". But a Today leaf row is a *single* `<button>` whose entire surface is the
   tap-to-tick target (PD-721/723); the card is built around tapping anywhere on the row to tick. A
   name that navigates can't be nested inside that button (invalid HTML / nested interactive), and
   splitting the row so the name navigates would shrink the tick target the Today design depends on.

## Decision

1. **`completionRate` / `setCompletionRate` (packages/shared/src/habits.ts) mirror the streak
   functions' period model and floor:**
   - Period = a **due day** for a days-of-week habit (and for a set, whose due/done are derived),
     a **week meeting N** for a per-week habit — the same model as `streak` / `setStreak`, so the
     header's two figures never disagree.
   - History is **floored at the earliest completion** (as the streak functions floor), so a
     habit's untracked past is never counted as a run of misses.
   - The **current period is excluded while in progress** (a due-today not yet done, or an unmet
     current week) — exactly as the streak functions treat it: neither a success nor a miss until it
     closes. A *done* current period counts.
   - Returns `{ done, total, rate }` with `rate = null` when the window holds no closed period (the
     header renders "—"), and honours a `periods` window (default `COMPLETION_RATE_PERIODS = 30`).

2. **On Today, the By Habit calendar opens from a dedicated per-row "open calendar" control**
   (a small 📅 button rendered beside the row, outside the tick button), **not** from the name
   text. This keeps the whole-row tap-to-tick intact. It is shown only on the page (not the compact
   card, which has no Log tab) and navigates to the deep link `?view=habit&item=<id>`, which the
   page reads to open the Log tab on that item. The deep link itself is the real contract; By Day
   (PD-725) will wire its own row-header source to the same URL.

## Alternatives rejected

- **Count the in-progress period as a miss** — penalises a rate mid-day/mid-week and would make the
  rate disagree with the streak, which is the one thing the header must not do.
- **Floor at item creation instead of earliest completion** — the 2025 import (PD-694) writes
  completions that predate `createdAt`, so creation is the wrong floor; earliest completion matches
  how streaks already bound history.
- **Make the Today name a link and shrink the tick button** — regresses the Today surface's core
  interaction for a feature that is reachable anyway via the dropdown and the deep link.

## Consequences

- The completion-rate helpers are pure and unit-tested in the server suite
  (`habits-stats.spec.ts`), beside the schedule/streak tests, since the shared package has no runner.
- Completions for the calendar are loaded once over a wide range (`fetchCompletions('2000-01-01', …)`)
  because the import predates `createdAt`; toggles mutate that list optimistically while the shared
  outbox (D-093) owns the durable, idempotent set-state write.
- Metrics appear in the dropdown but show no stats and no values here — the metric value store is a
  later slice (PD-724); a metric's cells are inert placeholders until it lands.
