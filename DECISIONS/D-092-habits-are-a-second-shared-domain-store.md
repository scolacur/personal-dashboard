# D-092: Habits are a second shared domain store in `apps/server/src/lib/`, beside the daily log — not widget tables, and not daily-log columns

**Date:** 2026-11-13
**Ticket:** PD-361 (Habit Tracker Widget) · **Extends:** [[D-090]] (the daily log is one shared domain store) · **Related:** PD-694 (Import the 2025 Daily Log), PD-696 (The correlations), PROJECT.md §5 (no cross-widget imports), §9 Habit Tracker glossary

## Context

The Habit Tracker (formerly planned as two widgets, Habit Log and Morning Routine) records
user-defined, recurring habits and one completion per habit per habit day. D-090 named it as a
consumer of the 2025 Daily Log import, and several of that log's columns (vitamins, Lift, Run, and
"Morning Routine Done By") are habit-shaped. The correlations (PD-696) need to read habit
completions alongside daily-log values.

D-090 settled that shared subject matter lives in `lib/`, but it was written as if the daily log
were *the* shared domain table. The question was whether habits go into it, beside it, or into the
widget's own tables.

## Decision

1. **Habits (including sets), metrics, and completions live in a shared habit store in `apps/server/src/lib/`.**
   The Habit Tracker widget owns its routes and UI only.
2. **It is a separate store from the daily log**, not columns in it. Habits are user-defined and
   change over time; a daily log row has a fixed shape.
3. **A completion records both its habit day and the moment it was made** (unix ms, per §5).
4. **The 2025 import maps habit-shaped columns into habit completions**, so habit history has one
   home rather than a parallel copy in the daily log.
5. **Metrics live in the same store.** A metric is an optional, typed daily value (Time, Number,
   Choice) logged from the same UI — drinks, Drugs, "Morning Routine Done By". They are user-defined
   for the same reason habits are, so the 2025 columns for drink, Drugs, weed (as the habit
   "No weed", inverted) and MR Done By import here, not into the daily log.
6. **"Morning Routine Done By" is not derived from completion timestamps.** Steve's call: tick times
   are not a reliable record of when the routine was actually finished (late ticking, batch
   ticking, backfill). It is a Time metric, logged explicitly.
7. As with D-090, the store's access layer is **middleware, not a firewall**.

## Alternatives rejected

**A. Widget-owned `habit_tracker_*` tables** (the Tinnitus Tracker pattern). Simplest, but the
correlations would have to read a widget's tables — the implicit cross-widget coupling D-090
rejected as its alternative A. Tinnitus entries stay widget-owned because nothing else reads them
and they are events, not a daily record.

**B. Completions as columns or rows in the daily-log store.** One store for everything, but it
forces dynamic, user-defined habits into a fixed day-row shape, and it would block the Habit Tracker
on PD-694's not-yet-designed schema.

**C. Derive "Morning Routine Done By" from the last `morning`-tagged completion time.** Free and
automatic, but rejected because tick time is not routine-finish time; a wrong value that looks
right is worse than a missing one in a correlation.

## Consequences

- D-090's "first shared domain table" remains true; this is the second, and the precedent the next
  one should follow.
- PD-694 imports into two stores: habit- and metric-shaped columns (vitamins, Lift, Run, No weed, drink, Drugs, MR Done By) into this one, the rest into the daily log.
- PD-696 reads both stores through their `lib/` accessors, never through widget folders.
