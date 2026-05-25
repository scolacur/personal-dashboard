# Workout Log — PROJECT.md

A widget for logging workout sessions. Track exercises, sets, reps, and weight over time. Useful for seeing progress and keeping a record of training history.

See also: [TODO.md](TODO.md)

---

## 1. MVP Scope

- Log a workout session with: date, duration, and a list of exercises
- Each exercise entry: name, sets × reps × weight (or bodyweight flag)
- View recent sessions in reverse-chronological order
- SQLite tables namespaced `workout_log_*` in the shared DB

### Explicitly NOT in MVP

- Exercise library / autocomplete (free-text name for now)
- Workout templates or programs
- Progress charts
- Rest timer
- Body weight / measurements tracking

---

## 2. Data Model (draft)

```sql
CREATE TABLE workout_log_sessions (
  id INTEGER PRIMARY KEY,
  logged_at INTEGER NOT NULL,   -- unix ms (start of session)
  duration_min INTEGER,
  notes TEXT
);

CREATE TABLE workout_log_exercises (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES workout_log_sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE workout_log_sets (
  id INTEGER PRIMARY KEY,
  exercise_id INTEGER NOT NULL REFERENCES workout_log_exercises(id) ON DELETE CASCADE,
  reps INTEGER,
  weight_kg REAL,
  bodyweight INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);
```

---

## 3. Open Questions

- Weight in kg or lbs? (Pick one; store in a consistent unit; display in whatever the user prefers)
- Should there be a "quick log" mode (just record that you worked out, no detail) for days when tracking every set feels like friction?
