# Task Monitor — Project Context

## What this is

A dedicated page within the Personal Dashboard for monitoring and controlling AI agent workflows. It gives real-time visibility into what agents are doing, surfaces errors, provides approve/reject controls, and queues messages that require human attention. It is a SvelteKit route within the existing monorepo — not a separate app.

---

## Screens

### Phase 1 — Core (build first)

**Sortie & Sortie Proxy Status** - Simple color-coded way to see at a glance that Sortie is operational.

**Tasks** — Kanban board: Backlog / In Progress / Review / Done. Sourced from the `agent_jobs` table. This is the primary view for knowing what agents are actually working on. Filterable by project, initiative, or agent.

**Activity Feed** — Chronological event log of agent actions: job started, job completed, error occurred, decision made, artifact produced (eg. a screengrab of a feature working) etc. Supports filtering by job or agent.

**Errors** — Structured error feed from the `agent_errors` table. Each entry shows source, message, timestamp, and the job it came from (if applicable). Errors persist until acknowledged.

**Inbox** — Messages queued from agents in three categories: (1) needs my input to continue, (2) decision made / significant progress, (3) needs attention. Each message links to the relevant job.

### Phase 2 — Operations visibility

**Scheduled Jobs** — Every cron job and scheduled task the agent has set up, with last-run status and next scheduled time. Proves proactivity and catches cases where the agent said it scheduled something but didn't.

**Sub-Agent Monitor** — Drill-down view per active agent job: live progress/status, output log, and token usage. Useful when running long multi-step tasks.

**CI/CD Area / Deployment Log** - With each deployment, get a brief summary of what's landed.

### Phase 3 - GUI for Human Levers

**Ability to kill / restart agents & processes that may be stuck.**
**Ability to update subagent config via GUI** (eg. what model they use)
**GUI for Issue Generation** - The process won't feel complete until I can use the dashboard's GUI itself to submit issues.

### Future improvements

**Projects** — Each project I'm working on, linked to its tasks, memories, and docs. Useful for asking "what moves Project X forward today?" Requires a project-tracking data model and possibly agent-written docs to be useful.

**Memory** — Searchable journal-style view of daily memory files and long-term memory. Requires the agent memory system to be in place first.

**Docs** — Indexed and searchable view of documents the agent has produced. Requires a docs convention/location to be established.

**Team** — Agent crew: names, roles, org structure, mission statement. More useful once there are multiple distinct agents with defined responsibilities.

**Visual Office** — 2D pixel-art office showing agents at their desks when working, away when idle. Fun, zero operational value, build last.

**Per-widget Issue Creation** - A small button in the corner of each widget causes the widget to visually flip around, revealing a settings / config area, containing a button that allows me to create an issue via prompt. Some issue detail can be pre-populated based on the widget. Do after we have Discord set up. Possible that the easiest thing is that writing out my issue in Github actually just sends a Discord message on my behalf, after we have discord set up. That way the Dashboard itself may not need to have any knowledge of / access to agents. It just posts a message, that message gets picked up by Sortie.

---

## Architecture

Follows the same conventions as every other widget in the project.

- **Frontend:** SvelteKit route at `apps/web/src/routes/agent-dashboard/`
- **Backend:** Widget registered at `apps/server/src/widgets/agent-dashboard/`
- **Database:** SQLite via `better-sqlite3`, same connection as the rest of the app
- **Polling:** 10–30 second client-side interval for real-time feel (no WebSocket needed for MVP)

The agent dashboard reads from and writes to SQLite tables populated by whatever process runs the agent jobs (a script, a CLI tool, Claude Code itself, or a future orchestrator). The dashboard does not dictate how agents are run — it just provides visibility into their state.

### Database tables

```sql
-- Active and historical agent job runs
agent_jobs (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL,   -- todo | in_progress | review | done | rejected | error
  agent       TEXT,
  created_at  INTEGER NOT NULL, -- unix ms
  updated_at  INTEGER NOT NULL,
  output      TEXT,            -- last known output / summary
  token_usage INTEGER,         -- cumulative tokens if available
  metadata    TEXT             -- JSON blob for extra fields
)

-- Structured error log
agent_errors (
  id          TEXT PRIMARY KEY,
  job_id      TEXT REFERENCES agent_jobs(id),
  source      TEXT NOT NULL,
  message     TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0
)

-- Inbox messages requiring human attention
agent_inbox (
  id          TEXT PRIMARY KEY,
  job_id      TEXT REFERENCES agent_jobs(id),
  type        TEXT NOT NULL,   -- needs_input | decision_made | needs_attention
  message     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  resolved    INTEGER NOT NULL DEFAULT 0,
  metadata    TEXT             -- JSON: reply options, links, etc.
)

-- Scheduled jobs registry
agent_schedule (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  cron_expr    TEXT NOT NULL,
  last_run_at  INTEGER,
  last_status  TEXT,
  next_run_at  INTEGER,
  enabled      INTEGER NOT NULL DEFAULT 1
)
```

### Future: PostgreSQL upgrade path

SQLite is the right choice now. If concurrent agent writes become a bottleneck (multiple agents writing job state simultaneously), the migration path is: add Postgres to Docker Compose, swap `better-sqlite3` for a Postgres client in the widget, keep the same schema. The `agent_jobs` table is the most likely candidate for this issue first.

---

## Agent job write protocol

For the dashboard to be useful from day one, agent jobs need to write state into SQLite as they run. The lightweight approach: a small helper script or shell function that agents call to update their job row. The agent dashboard doesn't care _how_ jobs are orchestrated — only that they write to the table.

When n8n or a similar orchestrator is added to the stack, it can be wired to write to these tables instead. The dashboard stays the same.

---

## Future: Automated maintenance features

These don't depend on the agent UI being built first — they're standalone jobs that would surface _results_ in the dashboard.

**Weekly Privacy Checkup** — Automated job that scans apps, dependencies, npm packages, Chrome extensions, and Docker images for known security issues. Results surface as `agent_errors` entries or inbox notifications.

**Construction Site queue** — TODOs in the repo that are blocked waiting for a technology/API to exist. A nightly background job checks whether blockers have resolved. If something unblocks, it surfaces in the inbox.

---

## Conventions

- Follows all global dashboard conventions (see root `PROJECT.md`)
- All tables namespaced with `agent_` prefix
- No cross-widget imports; anything shared goes in `packages/shared`
- Time stored as unix ms, never strings
- Inbox messages are never deleted, only marked `resolved`
