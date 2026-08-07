# D-014: Mission Control UI lives in Personal Dashboard; data owned by Symphony

**Decision:** The Mission Control / Agent Dashboard UI is a page inside the Personal Dashboard, consuming Symphony's HTTP API (`/api/v1/state` etc.). It owns no data of its own — all agent state, job history, inbox, and errors live in Symphony.

**Reasoning:**

- The primary use case is "one of several views on my daily dashboard." Keeping it in the Dashboard satisfies that without extra deployment overhead.
- Mission Control is a consumer of Symphony's API, not a part of Symphony. The UI and the service it observes are separate concerns — same as Datadog's dashboard not living inside the services it monitors.
- A standalone `mission-control` project (the earlier plan in CORE's META-TODOS) is overkill for what is one page calling one API. That decision predated the Dashboard existing as a project.
- The `agent_*` tables (`agent_jobs`, `agent_errors`, `agent_inbox`, `agent_schedule`) belong in Symphony's own SQLite, not the Dashboard's. The Dashboard calls Symphony's HTTP API to read them.

**Implications:** Symphony must expose its `/api/v1/state` endpoint (and related routes per the Symphony spec) on a known host:port. The Dashboard configures that address via env var (e.g., `SYMPHONY_URL`).

**Supersedes:** The `Projects/mission-control/` standalone project plan noted in CORE's META-TODOS.
