You are an agent helping me build this project.

At the start of EVERY session, do the following:

- Read PROJECT.md

Let me know when you've completed reading it.

**Backlog:** TODOs are no longer tracked in `TODO.md` files — they live as **tickets in the
Task Monitor** (`/task-monitor`), backed by the `agent_tickets` table.
The board is the single source of truth for project tasks across all projects. Query them via the
API (`GET /api/widgets/agent-dashboard/tickets`). The old `TODO.md`/`META-TODOS.md` files were
seeded into the board and archived to `/Users/steve/Documents/Dev/archive/` (see DECISIONS.md D-020).

If you are ever uncertain about why we are taking a certain design approach, read `DECISIONS.md` to see if the reasoning is there.

Whenever we make a significant architectural decision, add it to `DECISIONS.md`.
