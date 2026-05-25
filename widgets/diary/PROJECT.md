# Diary — PROJECT.md

A simple private journal widget. One entry per day; write whatever you want. Emphasis on low friction: open the widget, type, done. Daily mood logging as well.

Also includes Concert Diary Widget.


See also: [TODO.md](TODO.md)

---

## 1. MVP Scope

- Create or edit today's entry (plain text or basic Markdown)
- Browse past entries in reverse-chronological order
- Entries stored in SQLite, namespaced `diary_*`
- No auth beyond the LAN-only access the whole dashboard gets

### Explicitly NOT in MVP

- Search across entries
- Mood tracking or tagging
- Encryption at rest
- Export to file
- Rich text editor (plain textarea or a minimal Markdown editor)

---

## 2. Data Model (draft)

```sql
CREATE TABLE diary_entries (
  id INTEGER PRIMARY KEY,
  entry_date TEXT NOT NULL UNIQUE,  -- YYYY-MM-DD
  body TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

---

## 3. Open Questions
- Answer before building: Better to just do Capacities integration / embed vs. storing our own stuff?
- Plain textarea vs. a minimal Markdown editor (e.g., CodeMirror with Markdown mode)? A textarea is the lowest friction starting point.
- Encryption: the dashboard is LAN-only, so encryption is optional — but diary content is more sensitive than workout logs. Worth noting before building.
