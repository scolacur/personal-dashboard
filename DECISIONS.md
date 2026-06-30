# Decision Log

Captures the _why_ behind key choices made during planning. Useful when revisiting a decision later — if a choice no longer fits, the original reasoning makes it easier to see what changed and whether to revisit.

Newest decisions at the top.

---

## D-018: Pomodoro timer logic lives in `packages/shared`; tile renders full widget on home page

**Decision:** Pure Pomodoro timer logic (`formatTime`, `advancePhase`, `clampRoundsBeforeLongBreak`) lives in `packages/shared/src/pomodoro.ts` and is exported from `@dashboard/shared`. The home page renders a `PomodoroTimer.svelte` component directly inside a `.pomodoro-tile` card (not the generic `Widget` link card), so the timer is functional on the dashboard home as well as on its dedicated page.

**Reasoning:**

- Placing pure logic in `packages/shared` follows the established workaround (D-017) for testing shared logic: the server's vitest config imports from `@dashboard/shared` and tests the functions there.
- A generic `Widget` card (link + description) is wrong for the Pomodoro: the issue explicitly requires the timer to be usable inside the tile, not just linked from it. Inline rendering via an `{#if w.id === 'pomodoro'}` branch in `+page.svelte` is the minimal change that satisfies this without modifying the generic `Widget` component.
- Inputs are disabled while the timer is running to prevent confusing mid-session changes; settings take effect on reset or the next phase start.

**Alternatives considered:** Adding a `tileComponent` field to `WidgetMeta` (more generic, but requires importing Svelte component types into the registry); modifying `Widget.svelte` to accept snippet content (also more generic, but requires all callers to pass snippets). The `{#if}` branch is the smallest change and avoids premature abstraction.

---

## D-017: Sortie follow-up detection is state-based (existing PR), not `.run.is_continuation`

**Decision:** The agent prompt detects "this is a review-feedback / conflict-rework follow-up" by checking whether an **open PR already exists for the branch** (`gh pr view sortie/<id>`), NOT by Sortie's `.run.is_continuation` flag. On a follow-up the agent must fetch all feedback explicitly — `gh api .../pulls/<n>/reviews` (the top-level "Request changes" summary body), `.../pulls/<n>/comments` (inline, file+line), and `gh pr view --comments` — read its own prior diff, and **edit its existing work rather than append**. Two related conventions ride along: Sortie-authored changes must include **vitest tests for new/changed logic** (self-checked against the diff, continuations included), and PRs/commits get **descriptive conventional-commit titles**, never `sortie: resolve #N`.

**Reasoning:**

- **`.run.is_continuation` is false for the dispatches that matter.** Review-reaction and conflict-rework runs arrive looking like a fresh dispatch. The prior prompt gated the *entire* review-feedback section (and the nested `{{ range .review_comments }}`) behind `{{ if .run.is_continuation }}`, so it was dead code on exactly those paths. Confirmed from agent transcripts (2026-06-30, issue #22): the continuation banner rendered **0×** across all sessions, the agent never saw the feedback, and re-ran the issue from scratch — visibly "adding" instead of "fixing".
- **A summary "Request changes" body isn't surfaced by `gh pr view --comments`** — it must be fetched via the reviews API. The fallback "read the conversation yourself" was both gated-out and insufficient.
- **"Does my PR exist?" is the reliable, version-independent signal** — it doesn't depend on Sortie internals, and it covers conflict-rework (same false-`is_continuation` problem) for free.
- **Tests + descriptive titles** raise the quality bar for unattended work: untested logic is treated as incomplete, and `Closes #N` carries the issue link so titles are free to describe the change.

**Implications:** Builds on D-016 (the agent already owns the in-turn hand-off). **VERIFIED end-to-end 2026-06-30 on #26/PR #27**: a top-level summary review drove a continuation that fetched the review body (`/reviews` API called, feedback in context) and **edited** the single function + its existing test (no duplication) — the exact reversal of the pre-fix flail. Open follow-up: `packages/shared` has no vitest config, so shared logic is currently tested indirectly from `apps/server/src` (agent's documented workaround); giving `shared` its own test setup needs a devDep (a human/explicit issue, not unattended work).

---

## D-016: Sortie hand-off is done by the agent in-turn, not by `after_run`

**Decision:** The durable end-of-run hand-off for a Sortie issue — `git push`, `gh pr create`, writing `.sortie/scm.json`, and relabeling `sortie:in-progress → sortie:in-review` — is performed by the **coding agent during its own turn** (a "Finish" protocol in the `WORKFLOW.md` prompt body), not by the `after_run` workspace hook. `after_run` is demoted to an idempotent **safety-net** that only completes a hand-off the agent didn't finish. The label transition is additionally backstopped by an in-repo Action (`sortie-watchdog.yml` `rescue-labels` job).

**Reasoning:**

- On a `needs-human-review` exit, Sortie cancels the worker context. That cancellation **races with and kills `after_run` mid-execution** *and* Sortie's own `handoff_state` label transition (`error: context canceled`). Observed on #6/PR #17 and #8/PR #18 (2026-06-30): PR created but `scm.json` never written, and the issue left with **no** `sortie:*` label — invisible to both the review `reactions` and the watchdog.
- The agent's turn runs under a **stable context with the full environment** (egress proxy + token), so push/PR/scm.json done there are reliable. This mirrors the existing `ask_human` pattern, which already self-relabels from inside the turn.
- **Ordering is load-bearing:** the relabel to `sortie:in-review` must be the agent's **last** action. `in-review` is not in `active_states`, so applying it earlier can make the reconciler cancel the worker mid-turn — the very failure being fixed. Everything durable is completed first; the relabel + turn-end come last.
- **Belt-and-suspenders on the label** (Steve's call): the agent self-relabels AND `rescue-labels` sets `sortie:in-review` on any label-less issue that still has an open `sortie/*` PR — so a lost race is recovered regardless of cause, with no dependence on Sortie internals.
- **`scm.json` robustness:** `after_create` does `rm -rf` the (persistent, per-issue) workspace on each dispatch, and `scm.json` is not committed to the branch. To survive that regardless of *when* Sortie reads the file, `before_run` now **regenerates** `.sortie/scm.json` on the follow-up (existing-branch) path. (Whether Sortie reads it pre-wipe from the persistent workspace or post-clone from the fresh one is unconfirmed against this Sortie version — regenerating covers both.)

**Implications:** `self_review` stays enabled as a belt, but correctness no longer depends on which side of the context-cancel it runs — the agent runs `npm ci && npm run verify` as its own final gate (the `npm ci` is required: the fresh clone has no `node_modules`).

**VERIFIED end-to-end 2026-06-30** on #22/PR #23, settling the three previously-open items: (1) the agent turn's env *does* carry the proxy + `SORTIE_GITHUB_TOKEN` — the agent created the PR/scm.json in-turn (PR body shows the agent's `## Assumptions` template, not the safety-net's); (2) the agent self-relabel coexists with `handoff_state` — Sortie logged `handoff transition succeeded`, no `context canceled`; (3) the review-fix continuation located the PR and pushed to it (scm.json read works). Deploy is `sortie-refresh` (force-recreate — single-file bind-mount inode trap).

---

## D-015: Widget tile as a flippable card component (`lib/Widget.svelte`)

**Decision:** The dashboard home extracts widget tiles into a reusable `Widget.svelte` component. Each widget card has a front face (title + description + link to route) and a rear face (widget name + "Rear panel" stub), flipped by a button in the bottom-right corner using a CSS 3D `rotateY` transition.

**Reasoning:**

- The tile markup was inline in `+page.svelte` with no re-use path. Extracting it to a component keeps the home page clean and gives every widget the same visual chrome for free.
- CSS `transform: rotateY(180deg)` with `transform-style: preserve-3d` and `backface-visibility: hidden` achieves the card-flip animation with zero JavaScript and no extra dependencies.
- The flip button intercepts clicks with `e.preventDefault() + e.stopPropagation()` so the front face's `<a>` link still navigates normally on body clicks.
- The rear face is a stub today; it will host per-widget settings once that feature is built.

**Implications:** All widget registry entries in `lib/widgets.ts` automatically get a flippable card on the home page. Per-widget pages (`routes/widgets/<name>/+page.svelte`) are unaffected — they render their own full-page UI.

---

## D-014: Mission Control UI lives in Personal Dashboard; data owned by Symphony

**Decision:** The Mission Control / Agent Dashboard UI is a page inside the Personal Dashboard, consuming Symphony's HTTP API (`/api/v1/state` etc.). It owns no data of its own — all agent state, job history, inbox, and errors live in Symphony.

**Reasoning:**

- The primary use case is "one of several views on my daily dashboard." Keeping it in the Dashboard satisfies that without extra deployment overhead.
- Mission Control is a consumer of Symphony's API, not a part of Symphony. The UI and the service it observes are separate concerns — same as Datadog's dashboard not living inside the services it monitors.
- A standalone `mission-control` project (the earlier plan in CORE's META-TODOS) is overkill for what is one page calling one API. That decision predated the Dashboard existing as a project.
- The `agent_*` tables (`agent_jobs`, `agent_errors`, `agent_inbox`, `agent_schedule`) belong in Symphony's own SQLite, not the Dashboard's. The Dashboard calls Symphony's HTTP API to read them.

**Implications:** Symphony must expose its `/api/v1/state` endpoint (and related routes per the Symphony spec) on a known host:port. The Dashboard configures that address via env var (e.g., `SYMPHONY_URL`).

**Supersedes:** The `Projects/mission-control/` standalone project plan noted in CORE's META-TODOS.

---

## D-013: Symphony as standalone project; Claude Code as the agent runner

**Decision:** Symphony (the autonomous agent loop service) lives in the existing `multi-agent-linear-workflow/` project directory as a standalone Node.js service. It uses Claude Code CLI (`claude --print`) as its coding agent subprocess rather than OpenAI Codex app-server.

**Reasoning:**

- CORE is plain-text identity/config — build artifacts and a running daemon don't belong there. Same reasoning that put Mission Control outside CORE.
- Symphony can be deployed independently to the NAS without touching CORE's config.
- Staying on Claude Code keeps the entire stack consistent and avoids maintaining two agent runtimes.
- The Linear MCP integration already wired into the harness means agents can read/write Linear tickets natively — the `linear_graphql` client-side tool extension from the spec is effectively already implemented via MCP and doesn't need to be built.

**Adaptation from spec:** Section 10 (Codex app-server protocol) is replaced with `claude --print` CLI invocations. All other sections of the Symphony spec (orchestrator state machine, workspace lifecycle, Linear polling, retry/backoff, reconciliation, observability API) apply as written.

**SOUL injection:** The WORKFLOW.md prompt template per ticket injects the relevant agent's SOUL content from CORE, the same way TM does manually via `/dispatch` today. Symphony automates the dispatch loop.

---

## D-012: Multi-agent coding workflow (DIY Symphony) — full architecture deferred

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

---

## D-011: n8n deferred as workflow orchestrator

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

---

## D-010: PostgreSQL deferred; SQLite flagged for upgrade on agent dashboard

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

---

## D-009: All widgets share one SQLite database, namespaced by table prefix

**Decision:** Every widget stores data in the shared SQLite DB (`data/dashboard.db`). Tables are prefixed with the widget name (e.g., `habit_log_*`, `morning_routine_*`). No per-widget DB files.

**Reasoning:**

- A single DB file is trivially backed up and mounted in Docker.
- SQLite supports concurrent reads and serialized writes without any extra service — a separate DB per widget would add filesystem complexity with no benefit at this scale.
- Table namespacing is enough isolation; cross-widget queries are unlikely and can be discouraged by convention. If it ever matters, SQLite's `ATTACH DATABASE` handles it without breaking the single-file model.

**Revisit if:** A widget needs a fundamentally different storage model (e.g., blob storage, vector DB) that SQLite doesn't handle well.

---

## D-008: Build dashboard shell now, not later

**Decision:** PROJECT.md scopes both the shell and the first widget as MVP, not just the music tracker.

**Reasoning:** Conventions (widget registry, shared types, backend module boundaries) are much easier to establish before there's existing widget code to retrofit. The shell itself is cheap — a tile grid, a widget registry on each side, and a routing convention. The investment pays off the second widget.

**Revisit if:** I lose interest in building additional widgets after the music tracker. In that case the shell adds no value over a standalone app, but the cost was small enough that it's not worth tearing out.

---

## D-007: Show raw vs matched metadata side-by-side in the review UI

**Decision:** The Review tab shows the detected track and its match candidates as two columns, with raw fields preserved on both sides.

**Reasoning:** The matcher is deliberately loose (biased toward more matches). I can't review borderline matches without seeing both sides. Showing only "matched: yes/no" hides the information needed to tune the matcher over time. Also: nearly free to build, since the DB already stores both sides.

**Implications:** Schema needs a `matches` table (many-to-many) rather than a single `library_match_path` column on `tracks`, so multiple candidates per track can be shown.

---

## D-006: Fuzzy metadata matcher with duration as a gate, not a score component

**Decision:** Two-stage matching. Stage 1: filter library files to those within ±3s of the incoming track's duration. Stage 2: Fuse.js weighted fuzzy score on title (0.50), artist (0.35), remixer (0.15). Threshold 0.65 for "candidate," 0.85 for auto-confirm.

**Reasoning:**

- Duration is gating, not weighted, because a 3-min radio edit and a 7-min extended mix of the same song have identical metadata but are different tracks for a DJ. No amount of title similarity should override a duration mismatch.
- ±3s rather than ±1s because `music-metadata` reads file duration which can be slightly off for VBR MP3s.
- Two thresholds (0.65 / 0.85) let strong matches auto-resolve while medium-confidence matches go to manual review. Starts loose; tighten with observed data.
- Fuse.js because it handles token-set logic and weighted multi-field search well, and it's well-maintained.

**Revisit if:** False positive rate is high — tighten the 0.65 threshold first, then the weights. If false negatives from tag inconsistency dominate, that's the signal to implement Chromaprint (D-004).

---

## D-005: Track status as a small enum, not separate booleans

**Decision:** Single `status` column on tracks: `new` | `in_library` | `wanted` | `acquired` | `ignored`.

**Reasoning:** These states are mutually exclusive in practice. Encoding them as a single field avoids combinations that shouldn't exist (e.g., simultaneously `wanted` and `acquired`). Maps cleanly to UI filters. The `new → wanted/in_library/ignored → acquired` flow gives a natural review queue without committing to any particular download mechanism.

**Revisit if:** I add a "monitoring for better quality" feature — that's a separate axis from the acquisition status and would warrant a second column rather than expanding the enum.

---

## D-004: Defer Chromaprint/AcoustID fingerprinting to TODO

**Decision:** MVP uses normalized-metadata fuzzy matching only. Fingerprinting goes to TODO.md.

**Reasoning:** Chromaprint solves a different problem than I have. My problem is "Spotify gave me metadata; do I have a file with matching metadata." Chromaprint solves "I have two audio files; are they the same recording?" The Spotify side doesn't give me audio — only metadata and (sometimes) a 30s preview URL. To use Chromaprint I'd need to download previews, fingerprint them, and do partial-fingerprint matching against full songs. That's a lot of complexity for a benefit that's mostly "catches cases where my own tags are wrong."

Better sequencing: see what the metadata matcher actually gets wrong over 2-3 weeks of real use. If the failure mode is tag inconsistency within my library, Chromaprint is the right fix. If it's Spotify's metadata not matching my filename conventions, Chromaprint won't help — better normalization rules will.

**Revisit if:** After ~3 weeks of observed failures, tag inconsistency in the local library is clearly the dominant cause of false negatives.

---

## D-003: Scan the NAS mirror of the DJ library, not the PC directly

**Decision:** rsync pushes from PC → NAS on a schedule (configured separately on the NAS). The app reads only the NAS copy.

**Reasoning:**

- The app already runs on the NAS — local filesystem reads are fast, no SMB auth in the container.
- No dependency on the PC being on when the app wants to scan.
- A stale mirror is acceptable: worst case is a false "not in library," which becomes a manual review.
- Reaching back from a Docker container on the NAS to the PC is fragile (SMB mount in container, credentials, network changes).

**Revisit if:** The lag between adding a track on the PC and the app seeing it becomes annoying. The fix is to tighten the rsync interval, not to change this decision.

---

## D-002: Local DB queue instead of pushing everything to Lidarr automatically

**Decision:** Detected tracks land in a local SQLite database with a review/approval step. Lidarr API integration is deferred entirely; for MVP there's just a link out to the Lidarr UI.

**Reasoning:**

- Lidarr is album/artist-oriented and uses MusicBrainz for metadata. Mixes, bootlegs, white labels, and a lot of the rare electronic music I track are not in MusicBrainz, so Lidarr can't find them.
- "Point Lidarr at a custom DB as a source" isn't actually a thing Lidarr supports — its sources are MusicBrainz (metadata) and indexers (downloads). So the originally-considered "Option B" wasn't real.
- A local queue with manual review fits the actual content type better, and matches my stated preference for confirming replacements anyway.
- Keeps the architecture flexible for the future "swap Lidarr for direct mp3 site queries" feature, since the acquisition mechanism is decoupled from detection.

**Implications:** I am not building "a Lidarr alternative." I'm only replacing Lidarr's catalog-of-wants function (and only for tracks). Indexer search, quality decisioning, and download client integration stay out of scope.

**Revisit if:** The bulk of what I track turns out to be in MusicBrainz after all, and the manual review step feels redundant. Then it's worth adding the "auto-push to Lidarr" path as a per-source option.

---

## D-001: Node + TypeScript, not Go

**Decision:** Backend is Node.js + TypeScript with Fastify. Go is parked for a future widget.

**Reasoning:**

- I'm learning the language _and_ gluing together many external APIs (Spotify, eventually Lidarr, YouTube, SoundCloud, Bandcamp). The Node ecosystem for this domain is dramatically better: `@spotify/web-api-ts-sdk`, `music-metadata`, `node-cron`, and SDKs for everything else.
- I already know TypeScript — shared types and tooling with the Svelte frontend is a real win, especially for a dashboard hosting many small apps.
- Go's strengths (CPU-bound work, concurrency, deployment as a single binary) don't apply here. The workload is I/O-bound API glue.

**Revisit if:** A future widget is CPU-bound or concurrency-heavy (audio processing, real-time data, scraping at scale). Good candidate to introduce Go as a sidecar service.
