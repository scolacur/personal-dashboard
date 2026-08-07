# D-011: n8n deferred as workflow orchestrator

**Decision:** Not adding n8n to the stack. Agent workflows and cron jobs are triggered by scripts, Claude Code CLI, or the NAS task scheduler. The agent dashboard is orchestrator-agnostic — it reads from `agent_jobs` SQLite tables regardless of what writes to them.

**Why not now:**

- n8n adds a new container, a credential store, and workflow JSON files that need to be maintained alongside the codebase. That's real overhead for a one-person project where most triggers are manual.
- The agent dashboard data model (D-010-adjacent) was deliberately designed to be agnostic: any process that writes to `agent_jobs` / `agent_errors` / `agent_inbox` works. n8n can be plugged in later without changing the frontend.
- Webhook-triggered workflows (Spotify/YouTube polling, external event hooks) do need something like n8n. But those aren't being built yet.

**What n8n specifically solves that nothing else does:**

- Visual workflow editor — easier to inspect/modify automation logic without reading code
- Built-in retry/backoff on external API calls
- Reliable webhook ingestion with a persistent queue
- Fan-out to parallel agent workers (see D-012)

**Revisit if:** Scheduling needs outgrow cron-style scripts (need conditional logic, retries, or fan-out), or external webhook sources (Spotify, YouTube, GitHub) need to trigger workflows reliably. When that happens, add n8n to Docker Compose with Postgres backend and scope Tailscale Funnel to the n8n webhook port only.
