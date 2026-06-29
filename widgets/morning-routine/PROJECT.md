# Morning Routine — PROJECT.md

A daily checklist widget specifically for morning tasks. The list resets automatically each day so it's always a fresh slate. Designed to be the first thing checked when sitting down in the morning. It should encourage me to complete tasks with positive feedback.

See also: [TODO.md](TODO.md)

---

## 1. MVP Scope

- Fixed list of morning tasks (configured once, not frequently edited)
- Checklist resets at midnight (or a configurable reset time)
- Completion state stored per day so there's a record
- Minimal UI: large checkboxes, clean layout
- SQLite tables namespaced `morning_routine_*` in the shared DB
- Each day's progress is saved in the database and there is
- a link to view historical data so i can see how I do over time on each morning task, as well as total percent completion of morning tasks.

- Morning tasks would be things like: Chug water, stretch/move around/go outside, take meds, brush teeth/shower, clean facemask, tidy up.
- There should be an easy way to add, remove, and rename tasks

### Explicitly NOT in MVP

- Reordering tasks (fixed order is fine)
- Data insights: spot trends, correlations, including with things like seasonality, weather, and later, even diary
- Time tracking per task
- Streak display (that's Habit Log's job)
- Multiple lists / profiles

---

## 2. Data Model (draft)

```sql
CREATE TABLE morning_routine_tasks (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE morning_routine_completions (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES morning_routine_tasks(id) ON DELETE CASCADE,
  completed_on TEXT NOT NULL,  -- YYYY-MM-DD
  completed_at INTEGER NOT NULL,
  UNIQUE(task_id, completed_on)
);
```

---

## 3. Open Questions

- Reset time: midnight server time, or user-configurable (e.g., 4 AM so late nights don't count as the next day)?
- Should incomplete tasks from yesterday surface any kind of warning? For now, yes. lets see if it helps me keep it updated.
