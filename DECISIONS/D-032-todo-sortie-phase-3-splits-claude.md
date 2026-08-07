# D-032: The TODO→Sortie "Phase 3" splits — Claude formatting moves to Refine (PD-172); the Queued poller (PD-164) is mechanical and Claude-free

**Decision:** [[D-020]] framed "Phase 3" as a single Claude-API "Convert to issue" step (format +
draft-then-approve + create + link). That step is **split in two**:

- **Formatting is upstream, in Refine ([[D-033]], PD-172):** the Claude-powered work of turning a
  rough backlog blurb into well-formed, Sortie-shaped tickets happens (human-gated) on the
  **backlog→Ready** transition.
- **Issue creation is mechanical, in the Queued poller (PD-164):** a node-cron poller (extending
  PD-165's GitHub-sync poller) finds tickets that are **currently `queued`, `sortie_enabled`, have a
  `github_repo`, and have `githubIssueNumber = null`**, then creates a GitHub issue **verbatim from
  the ticket's existing title+body**, labels it `sortie:queued`, and writes
  `githubIssueNumber`/`githubIssueUrl` back to the row. **No Claude, no Convert button, no second
  approval.**

**Why:**

- **Dragging a ticket to `queued` IS the approval.** By the time a ticket reaches the Queued lane it
  has already been refined + deliberately advanced by a human, so a second draft-then-approve gate at
  issue-creation is redundant. The Queued lane ([[D-026]]) becomes the dispatch boundary.
- **The ticket body is already Sortie-formatted** by Refine, so re-running it through Claude at
  creation adds cost + latency + nondeterminism for no gain. PD-164 collapses to a pure GitHub-**write**
  extension of PD-165's existing poller (shared cron registry + GitHub client) and **loses its
  `ANTHROPIC_API_KEY` dependency entirely**.
- **Two poll directions, one poller foundation.** PD-165 reads GitHub→board (derived status from
  `sortie:*` labels + PR state); PD-164 writes board→GitHub (create+link on Queued). They share the
  cron + GitHub-client scaffolding, so PD-164 is built on PD-165, not duplicated.

**Trade-off:** A ticket dragged straight to Queued **without** going through Refine gets an issue
created from its raw body — a rougher issue. Mitigated **deterministically** by PD-177: on the
transition into `queued`, a shared `isSortieReady(body)` validator (checks for the required
`## Context` / `## Task` / `## Done When` / `## Out of scope` sections — no Claude) **warns** the
human so they can Refine first. Accepted over a Claude safety-net in the poller, which would
reintroduce the exact cost/coupling this split removes.

**Implications:** PD-164 needs only a **write-scoped** GH token (issues + labels) — not Anthropic.
Idempotency is by the `githubIssueNumber = null` guard + same-tick write-back (negligible dupe risk
on a crash between create and write-back, hand-fixable on a single-user board). The `isSortieReady`
validator lives in `packages/shared` so the UI warning (PD-177) and, if ever wanted, the poller can
share one definition of "Sortie-ready shape." This supersedes the single-step framing in [[D-020]]'s
"Phase 3"; [[D-033]] covers the Refine side.
