# D-010: PostgreSQL deferred; SQLite flagged for upgrade on agent dashboard

**Decision:** The project stays on SQLite. The agent dashboard specifically notes PostgreSQL as the recommended upgrade path if concurrent agent writes become a bottleneck.

**The tension:** Every other widget in this project writes from a single server process — SQLite's serialized writes are fine. The agent dashboard is different: if multiple agents run in parallel (see D-012), they all write job state simultaneously. SQLite's write lock becomes a real bottleneck at that point.

**Why SQLite now anyway:**

- Current usage is one agent at a time, manually triggered. No concurrency issue exists yet.
- Adding PostgreSQL now means a new Docker service, a new connection layer, and diverging from the rest of the project's data conventions — all for a problem that doesn't exist yet.
- SQLite to Postgres migration is well-defined: `pg_dump`-style tooling exists, schema is the same, only the driver changes.

**Migration trigger:** When D-012's parallel agent fan-out is implemented (more than one agent writing `agent_jobs` rows concurrently), migrate the `agent_*` tables to Postgres. Other widget tables can stay in SQLite until there's a reason to move them.

**Migration path when ready:**

1. Add Postgres service to Docker Compose with persistent volume and `.env` credentials
2. Swap `better-sqlite3` for `pg` (or Drizzle ORM) in the agent-dashboard widget only
3. Move `agent_jobs`, `agent_errors`, `agent_inbox`, `agent_schedule` tables to Postgres
4. Keep all other widget tables in SQLite (or migrate opportunistically)
