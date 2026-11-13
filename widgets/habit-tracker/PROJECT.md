# Habit Tracker — PROJECT.md

One widget for **recurring** things: daily habits, the morning routine, vitamins and meds, plus a
few optional daily **metrics** (drinks, Drugs, "Morning Routine Done By"). It replaces the two
widgets once planned separately, Habit Log and Morning Routine.

Epic: PD-361 (Habit Tracker Widget). Designed in a grilling session on 2026-11-13. The terms used
here (Habit, Set, Metric, Habit day, Habit week, Extra, Streak, Set progress, Archived habit) are
defined in the root `PROJECT.md` §9, under "Habit Tracker". Storage: D-092 (habits are a second
shared domain store in `lib/`).

One-off todos with deadlines are **not** this widget. They belong to PD-461 (the TODO app).

---

## 1. Concepts in one paragraph

A **habit** is done or not, once per **habit day**. It has a **schedule**: days of week, or N times
per week. A **set** is a habit with children, nested to any depth. It is done when every child due
that day is done, so it is never ticked on its own. Ticking a set ticks all its due children at
once. A **metric** is an optional typed daily value (Time, Number, or multi-select Choice). It is
never due and has no streak. Items are ordered by hand among their siblings, and each has at most
one parent.

## 2. Rules

- **Habit day.** It runs from the day boundary (default **04:00**) to the next one, in the home
  timezone (default **America/New_York**). Both are settings in the store, editable on the Habits
  tab, and every "today" is computed with them, on the server and the client alike.
- **Habit week.** Monday to Sunday, fixed.
- **Schedules.**
  - Only leaf habits have one. A set is due on any day where at least one child is due.
  - A schedule change takes effect from the habit day it is made. Earlier days are always judged by
    the schedule in force at the time, so history is never rewritten. Renaming changes no history
    either.
- **Due and not due.**
  - A days-of-week habit is not on Today on a day it isn't due.
  - An N-per-week habit is on Today every day. Once N is reached it shows as done for the week
    ("✓ 3/3 this week").
  - A completion on a day the habit wasn't due is an **extra**: it is shown, and it doesn't affect
    the streak.
- **Streak.** The number of consecutive periods met: due days for days-of-week habits, weeks for
  N-per-week habits, derived days for sets. Shown on a row from 🔥2 upward.
- **Set progress.** Due children done out of due children ("2/3"). A nested set counts as one
  child. Metrics never count.
- **Completions** record the habit day and the moment of the tick in unix ms. "Morning Routine Done
  By" is **never** derived from tick times. It is a Time metric (D-092 §6).
- **Metric values.** "Not logged" and a logged 0 are different. A metric's type cannot change once
  it has values.
- **Archiving** removes an item from Today and keeps all its history. **Deleting** erases the item
  and all its completions, after a confirmation that names the count ("Delete Gym and its 84
  completions?").
- **Unticking** never asks for confirmation.

## 3. Surfaces

### Dashboard card

- Today's checklist, with the filter chips and the yesterday banner. Tap to tick.
- No editing of items and no history.
- The header links to the page (D-062).

### Page `/widgets/habit-tracker`. Tabs: Today · Log · Habits

**Today**

- **Filter chips:** **All**, then one chip per **top-level set**, each showing that set's progress.
- **The list** is a tree in manual order:
  - Sets are expanded by default. Collapse state is per device (localStorage).
  - A set that becomes done collapses itself to one line ("✓ Vitamins 4/4 🔥12"). Tapping it
    re-expands it.
  - A partly done set shows a partial checkbox. Tapping it completes the rest and never clears
    what's done.
- **Metrics** appear in their own section below the habits, as inline inputs: a time picker, a
  number field, or a multi-select of choices.
- **Yesterday banner:** "Yesterday: N habits unchecked". It is dismissible and only covers
  yesterday. Tapping it opens Log › By Day scrolled to yesterday.
- **Completion feedback**, in layers:
  - Each tick plays a spring-fill animation.
  - When a set completes, its row and chip pulse.
  - When the whole day is done, a short burst plays, at most once per habit day. Unticking and
    re-ticking doesn't replay it.
  - Streak milestones (7, 30, 100, …) get a small flourish on the row.
  - There is no sound.

**Log**, with two views:

- **By Day.**
  - A grid with items as rows (sets indented above their children, metrics below the habits) and
    habit days as columns. Today is the rightmost column, and the grid opens scrolled to it.
    Scrolling left lazy-loads 30 more days at a time.
  - A **flip axes** button swaps this, so days become rows with today at the top and older days
    loading downward. The orientation is remembered per device (localStorage).
  - Cells:
    - Done cells are filled. Not-due cells are muted but still tappable, and ticking one records
      an extra.
    - Set cells are derived: filled when done, partial when partly done.
    - Metric cells show the value ("8:42", "2", "weed, mdma").
  - Tapping a habit cell toggles it. Tapping a metric cell edits its value. This is how past days
    get fixed.
- **By Habit.**
  - A dropdown lists active habits, sets and metrics in manual order, then an "Archived" group.
  - The calendar has one row per habit week (Mon–Sun), with the newest week at the **bottom**. It
    opens scrolled to the bottom, and scrolling up lazy-loads earlier weeks one at a time.
  - Month names sit in a left gutter, each with a line spanning that month's first to last day.
  - Cells use the same done / not-due / extra styling as By Day and toggle on tap.
  - Header stats: current streak, longest streak, and completion rate over the last 30 due
    periods. A metric shows its values with no stats.
  - Tapping an item's name anywhere (a Today row, a By Day row header) opens By Habit on it.

**Habits** (manage)

- Add, rename, archive and delete habits, sets and metrics.
- Drag to reorder among siblings and to move an item into or out of a set, using native drag
  (D-069).
- Edit a schedule, which starts from today. Edit a metric's type (only before it has values) and
  its choice options.
- The day boundary and home timezone settings live here.

## 4. Offline

Ticks and metric values go through a localStorage outbox, the one the Tinnitus Tracker built,
lifted into `apps/web/src/lib/`. Every write is a **set-state** message ("item X on day D is done",
"item X on day D is not done", "metric M on day D = value / cleared"), so replays are idempotent
and the last write wins. The UI updates optimistically and shows "N pending sync". A cold page load
offline still fails; the service worker for that is a separate ticket.

## 5. Data (shared store, D-092)

The store lives in `apps/server/src/lib/habits.ts`, with its schema bootstrapped inline like
`lib/job-runs.ts`. It is not in a widget folder. It is a sketch, so the slice that builds it owns
the final shape:

```
habit_items       (id, parent_id NULL → habit_items, kind 'habit'|'metric',
                   metric_type NULL|'time'|'number'|'choice', name, sort_order,
                   archived_at NULL, created_at)
habit_schedules   (id, item_id, effective_from_day 'YYYY-MM-DD',
                   kind 'days_of_week'|'per_week', days_mask NULL, per_week_n NULL)
habit_completions (item_id, day 'YYYY-MM-DD', completed_at unix ms,
                   PRIMARY KEY (item_id, day))
habit_metric_values (item_id, day, value TEXT  -- 'HH:MM' | number | JSON array of option ids,
                   updated_at, PRIMARY KEY (item_id, day))
habit_choice_options (id, item_id, label, sort_order, archived_at NULL)
habit_settings    (single row: day_boundary_minutes default 240, timezone default 'America/New_York')
```

`day` is a **habit day**: a local calendar date, not an instant, so it is a `YYYY-MM-DD` string.
Instants are unix ms, per §5.

The 2025 Daily Log import (PD-694) writes vitamins, Lift and Run as habit completions, `weed`
inverted as completions of "No weed", and drink, Drugs and MR Done By as metric values.

## 6. Not in scope (follow-ups)

- Reminders (PD-107).
- A Workout Log entry auto-ticking Lift or Run (noted on PD-360).
- A service worker for cold offline loads.
- Sound, and a chip default based on time of day.
- Tags: designed, then dropped in favour of sets.
- Week-level "2/3" summaries in By Day.
