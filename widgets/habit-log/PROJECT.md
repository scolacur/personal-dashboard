# Habit Log — PROJECT.md

A widget for tracking daily habits. Each day presents a checklist of habits the user wants to build; completions are recorded over time so streaks and history can be visualized.

See also: [TODO.md](TODO.md)

---

## 1. MVP Scope

- CRUD for habits (name, target frequency: daily/weekly, description)
- Daily checklist view: one checkbox per active habit, resets at midnight
- Completion stored per day so history survives the reset
- Habits can be created and archived via the UI
- Habits are easily renameable and re-orderable via the UI
- Simple streak display (current streak, longest streak)
- SQLite tables namespaced `habit_log_*` in the shared DB
- Simple monthly view with a satisfying interface for completing stuff & hitting goals

### Explicitly NOT in MVP

- Reminders / push notifications
- Habit categories or grouping
- Charts and history visualization (beyond basic streak)
- Habit archiving (just delete for now)

---

## 2. Data Model (draft)

```sql
CREATE TABLE habit_log_habits (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'daily',  -- 'daily' | 'weekly'
  created_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE habit_log_completions (
  id INTEGER PRIMARY KEY,
  habit_id INTEGER NOT NULL REFERENCES habit_log_habits(id) ON DELETE CASCADE,
  completed_on TEXT NOT NULL,  -- YYYY-MM-DD (local date)
  completed_at INTEGER NOT NULL,  -- unix ms
  UNIQUE(habit_id, completed_on)
);
```

---

## 3. Open Questions

- Should weekly habits let the user pick which day of the week, or just track "any day this week"?
- How to handle timezone? Server timezone or user-configurable?
