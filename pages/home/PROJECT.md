# Home — PROJECT.md

The default landing page of the dashboard. Shows a grid of all active widget tiles, grouped into sections, each linking to its full-page view.

Morning Dashboard section at top which contains Music Picker Widget and Morning Routine Widget

A small Quick Links section, which for now is just links to web apps I frequently use.

- Workflowy
- Google Cal
- Personal Gmail
- NAS
- GMaps Widget

A Simple daily todo list that shows a fresh empty list each day. Each list is saved to the db.

See also: [TODO.md](TODO.md)

---

## 1. MVP Scope

- Tile grid: one card per registered widget
- Each card shows the widget name and a brief description
- Clicking a tile navigates to the widget's full route
- Layout driven by `apps/web/src/lib/widgets.ts` registry — no config UI needed for MVP

### Explicitly NOT in MVP

- Widget previews / live data in the tile (just name + description)
- Drag-to-reorder or resize on this page (that's the grid system improvement in shell/TODO.md)
- Per-page grouping (all widgets in one grid for now)

---

## 2. Open Questions

- Should tiles be grouped by page/category (Productivity, Music, etc.), or one flat grid on Home?
