# D-020: Cross-project ticket backlog (`agent_tickets` + `agent_projects`), distinct from D-014 agent-run tables

**Decision:** The Agent Dashboard is a **cross-project** Kanban — it tracks TODOs for *all* Steve's
projects (personal-dashboard, core, nervous-system-website, …), not just the dashboard. Backed by
dashboard-owned tables: `agent_projects` (with a display-id `key` like `PD`/`C`/`NSW`, `github_repo`,
`sortie_enabled`, `color`) and `agent_tickets`, plus `agent_ticket_relations` (blocks/relates/duplicates),
`agent_tags` + `agent_ticket_tags`, `agent_ticket_events` (activity log), and `agent_ticket_reminders`.
Five statuses map to columns: `backlog`/`ready` set **manually**; `in_progress`/`in_review`/`completed`
**derived** from GitHub once a TODO is converted to a Sortie issue, cached on the row. This is Phase 1
of the TODO → Sortie-issue pipeline (Kanban now; seed-import Phase 2; Claude-API "Convert to issue" Phase 3).

**Reasoning:**

- **Does not conflict with D-014.** D-014 put the agent *run* tables (`agent_jobs`, `agent_errors`,
  `agent_inbox`, `agent_schedule`) in the agent runner (Sortie's `.sortie.db`), dashboard as
  read-only consumer. `agent_tickets` is Steve's *backlog*, owned by the dashboard, predating any run.
  The dashboard only *reads/caches* run-state for the derived statuses.
- **Derived statuses come from GitHub labels, not the Sortie API.** The `sortie:*` labels are the
  state machine (see `ops/sortie/WORKFLOW.md`). Polling GitHub needs no new infra and avoids coupling
  to Sortie's `:7678` API (on an `internal: true` network, no host route).
- **Per-project display IDs** (`PD-7`, `C-3`) via integer PK + a `display_id` string (not UUID —
  single-node SQLite gains nothing from UUID and loses readability). `agent_projects.seq` is bumped
  per create; numbers are never reused.
- **Relations generalized** (one table + `type`) so `relates`/`duplicates` need no new table.
  **Soft-delete** (`archived_at`) keeps deletes recoverable (data-safety). **Tags** normalized so
  they're addable/renamable. **Activity log** feeds the agent-dashboard spec's future Activity Feed.
- **Seed then archive (not delete).** Phase 2 parses each repo's `TODO.md`/`META-TODOS.md` (completed
  "Shipped" items seeded as `completed`) into a committed seed JSON + importer, then the source files
  are **renamed `TODO-<domain>.md` and moved to `/Users/steve/Documents/Dev/archive/`** — out of the
  repos (git history retains them) but preserved on disk (Backblaze-backed). The DB is then the single
  source of truth.

**Implications:** Only backlog/ready are hand-set; the derived three wire to GitHub polling in Phase 3.
Frontend for relations/tags/reminders/recurring/assignee/drag-reorder/Activity-Feed is deferred to
follow-up cards; the schema reserves all of it now. The board is a *page* (`/agent-dashboard`), not a
home-tile widget.
