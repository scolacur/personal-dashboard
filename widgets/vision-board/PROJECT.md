# Vision Board — PROJECT.md

A place to capture and reflect on long-term goals. Sits on the Productivity page as a persistent reminder of what you're working toward at a higher level than daily habits or tasks.

See also: [TODO.md](TODO.md)

---

## 1. MVP Scope

- A list of goals, each with: a title, an optional longer description, and an optional target date
- Goals organized into a small number of life areas (e.g., Health, Music, Career, Personal — user-defined)
- Simple card layout: one card per goal, displayed as a grid
- Full CRUD: add, edit, delete goals and areas
- SQLite tables namespaced `vision_board_*` in the shared DB

### Explicitly NOT in MVP

- Image/mood board uploads (text-only for now)
- Progress tracking or sub-tasks per goal
- Linking goals to habits or other widgets
- Goal templates
- Archiving completed goals (just delete for now)

---

## 2. Data Model

```sql
CREATE TABLE vision_board_areas (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE vision_board_goals (
  id INTEGER PRIMARY KEY,
  area_id INTEGER REFERENCES vision_board_areas(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  target_date TEXT,               -- YYYY-MM-DD or YYYY (year-only); NULL if open-ended
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

---

## 3. Frontend

Cards grouped by life area, displayed in a masonry or uniform grid:

```
┌─── MUSIC ──────────────────────────────────┐
│  ┌──────────────────┐ ┌──────────────────┐  │
│  │ Release an EP    │ │ DJ a festival    │  │
│  │ by end of 2026   │ │                  │  │
│  └──────────────────┘ └──────────────────┘  │
└────────────────────────────────────────────┘
┌─── HEALTH ─────────────────────────────────┐
│  ┌──────────────────┐                       │
│  │ Run a half       │                       │
│  │ marathon         │                       │
│  └──────────────────┘                       │
└────────────────────────────────────────────┘
```

- Click a card to expand/edit it
- "Add goal" button per area, "Add area" at the bottom
- Settings panel (wrench): reorder areas, rename/delete areas

---

## 4. Open Questions

- Should completed goals be archived (soft-delete) rather than hard-deleted, so there's a record of what you've accomplished?
- Is a target date useful enough to surface prominently, or should it be secondary metadata?
- Should this widget link to or aggregate from Habit Log (e.g., show habit completion rate for habits tagged to a goal)?
