# D-012: Multi-agent coding workflow (DIY Symphony) — full architecture deferred

**Decision:** Not implementing the parallel multi-agent coding workflow yet. For now, agent tasks are triggered manually one at a time via Claude Code CLI.

**What was deferred:** An earlier planning document described a complete autonomous multi-agent architecture for building this codebase:

- A `tasks/` folder of markdown files with YAML frontmatter (`id`, `title`, `status`, `assigned_to`, `priority`) that agents parse to claim work
- A `git worktree` per agent task, so multiple agents work on isolated branches simultaneously without stepping on each other
- A Postgres-backed semaphore (integer counter) to cap the number of parallel agents
- An n8n fan-out workflow: pick todo tasks → spawn parallel agent workers → each worker claims a task, creates a worktree, runs Claude Code, waits for a commit, then signals for human review
- Ntfy push notifications with a diff summary and approve/reject webhook URLs
- A human-in-the-loop review gate between agent completion and merge

**Why deferred:**

- All of this infrastructure is only worth the complexity once there are enough queued tasks that manual triggering becomes the bottleneck. Right now, manually kicking off one agent at a time is fine.
- Git worktrees are a real win for concurrent work but add operational overhead (stale worktrees, branch management) that isn't justified yet.
- The Ntfy + webhook approve/reject loop requires a publicly reachable webhook endpoint, which we don't have on the Synology NAS without Tailscale Funnel or a reverse proxy.

**Revisit if:** Tasks are piling up faster than one agent can process them, or the workflow moves toward truly autonomous nightly runs without manual triggering per task. At that point, implement in this order: (1) task file schema + worktree scripts, (2) single-agent loop with human review gate, (3) fan-out to parallel agents, (4) semaphore to cap concurrency.
