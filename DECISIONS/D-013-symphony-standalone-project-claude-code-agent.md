# D-013: Symphony as standalone project; Claude Code as the agent runner

**Decision:** Symphony (the autonomous agent loop service) lives in the existing `multi-agent-linear-workflow/` project directory as a standalone Node.js service. It uses Claude Code CLI (`claude --print`) as its coding agent subprocess rather than OpenAI Codex app-server.

**Reasoning:**

- CORE is plain-text identity/config — build artifacts and a running daemon don't belong there. Same reasoning that put Mission Control outside CORE.
- Symphony can be deployed independently to the NAS without touching CORE's config.
- Staying on Claude Code keeps the entire stack consistent and avoids maintaining two agent runtimes.
- The Linear MCP integration already wired into the harness means agents can read/write Linear tickets natively — the `linear_graphql` client-side tool extension from the spec is effectively already implemented via MCP and doesn't need to be built.

**Adaptation from spec:** Section 10 (Codex app-server protocol) is replaced with `claude --print` CLI invocations. All other sections of the Symphony spec (orchestrator state machine, workspace lifecycle, Linear polling, retry/backoff, reconciliation, observability API) apply as written.

**SOUL injection:** The WORKFLOW.md prompt template per ticket injects the relevant agent's SOUL content from CORE, the same way TM does manually via `/dispatch` today. Symphony automates the dispatch loop.
