# Acute Strategies Generator — PROJECT.md

A widget that surfaces a random musical idea or technique from a user-maintained list. Inspired by Brian Eno's Oblique Strategies. Useful for breaking creative blocks during music production sessions.

See also: [TODO.md](TODO.md)

---

## 1. MVP Scope

- Maintain a list of strategies/ideas (stored in SQLite, namespaced `acute_strategies_*`). Steve currently has these ideas in a Google Drive spreadsheet.
- "Draw a card" button — fetches and displays a random strategy
- Full CRUD: add, edit, delete strategies from within the widget UI
- No categories or tags in MVP — just a flat list
- Drawn strategy should be shown inline in the widget.
- Show a cute flip animation when the card is drawn, if not too difficult.

### Explicitly NOT in MVP

- Categories / tags
- "Don't repeat until all seen" deck mode
- Import/export from Oblique Strategies or other card decks
- Per-strategy history (how many times it was drawn)
- Maybe a button per-strategy that I can click when I've actually used it. Or a notes field to show how I used it.

---

## 2. Data Model (draft)

```sql
CREATE TABLE acute_strategies_items (
  id INTEGER PRIMARY KEY,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```
