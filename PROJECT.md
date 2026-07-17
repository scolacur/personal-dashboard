# Personal Dashboard — PROJECT.md

A locally-hosted personal dashboard running on a Synology NAS in Docker, composed of widgets (mini-apps). Widgets are customized tools to help me accomplish various tasks. Some interact with external APIs, some speak to a database we will create. Accessible via web browser.

Example widgets:

- A todo checklist, just for morning tasks, that refreshes every day.
- A simple Pomodoro timer that floats persistently in the bottom corner of the screeen.
- A habit tracker
- A workout log
- Acute strategies generator - a simple app that fetches random ideas from a list of musical ideas and techniques that i maintain. it also allows me to add/remove/edit items in that list.
- A music tracker that detects new additions to external playlists and tracks whether I already have them in my DJ library.
-

Each widget should exist in a movable and resizable card, like in a datadog dashboard.

This document is the source of truth for project scope, architecture, and conventions.

---

## 1. Scope

### MVP scope

- Dashboard shell (frontend + backend) ready to host multiple widgets
- One widget implemented end-to-end: **Music Tracker** — see [widgets/music-tracker/PROJECT.md](widgets/music-tracker/PROJECT.md)
- Runs in Docker on Synology NAS
- Accessed via browser on LAN only (no auth)

### Explicitly NOT in MVP (tracked as tickets in the Agent Dashboard board)

- Additional widgets (habit tracker, workout log, pomodoro, diary, etc.)
- Authentication
- Accessible outside of LAN (set up reverse proxy) so user can access it on their phone off of the wifi network the NAS sits on

---

## 2. Architecture

### Repo layout

Monorepo using npm workspaces.

```
dashboard/
├── apps/
│   ├── server/                    # Node + TypeScript + Fastify backend
│   │   ├── src/
│   │   │   ├── index.ts           # Entry point: starts Fastify, loads widgets
│   │   │   ├── db.ts              # SQLite connection, schema bootstrap
│   │   │   ├── schema.sql         # Idempotent schema, run on startup
│   │   │   ├── cron.ts            # Cron registry; widgets register jobs here
│   │   │   ├── logger.ts          # Pino logger + log persistence for UI
│   │   │   └── widgets/
│   │   │       └── music-tracker/
│   │   │           ├── index.ts           # Registers routes + cron jobs
│   │   │           ├── routes.ts          # HTTP handlers
│   │   │           ├── sources/           # Pluggable source implementations
│   │   │           │   ├── types.ts       # MusicSource interface
│   │   │           │   ├── spotify.ts     # Spotify playlist poller
│   │   │           │   └── manual.ts      # Manual entry "source"
│   │   │           ├── library.ts         # DJ library scanner + indexer
│   │   │           ├── matcher.ts         # Fuzzy matching logic
│   │   │           └── normalize.ts       # Metadata normalization rules
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── web/                       # Svelte + TypeScript + SCSS frontend
│       ├── src/
│       │   ├── app.html
│       │   ├── routes/
│       │   │   ├── +layout.svelte         # Dashboard shell (nav, theme)
│       │   │   ├── +page.svelte           # Home: widget tiles
│       │   │   └── widgets/
│       │   │       └── music-tracker/
│       │   │           ├── +page.svelte           # Main view
│       │   │           ├── ReviewQueue.svelte
│       │   │           ├── ManualEntry.svelte
│       │   │           ├── LogPanel.svelte
│       │   │           └── api.ts                  # Typed fetch wrappers
│       │   └── lib/
│       │       ├── widgets.ts             # Widget registry (tiles on home)
│       │       └── styles/                # Shared SCSS
│       ├── svelte.config.js
│       ├── vite.config.ts
│       └── package.json
├── packages/
│   └── shared/                    # Cross-cutting TS types
│       ├── src/
│       │   ├── music-tracker.ts   # Track, MatchCandidate, Status, etc.
│       │   └── index.ts
│       └── package.json
├── docker/
│   ├── Dockerfile
│   └── docker-compose.yml
├── data/                          # Persistent (mounted volume): SQLite, logs
├── .env.example
├── package.json                   # Workspaces root
└── PROJECT.md
```

*(Backlog note: TODOs are no longer tracked in `TODO.md` files — they live as tickets in the
Agent Dashboard board (`agent_tickets`); the originals were seeded in and archived to `Dev/archive/`.)*

### Stack

- **Runtime:** Node.js 20 LTS
- **Language:** TypeScript (strict mode) everywhere
- **Backend framework:** Fastify
- **Frontend:** SvelteKit (SSR off, just static + client; runs as a SPA served by Fastify in prod) + SCSS
- **Database:** SQLite via `better-sqlite3` (synchronous, fast, no extra service)
- **Scheduler:** `node-cron` for in-process scheduled jobs
- **Fuzzy matching:** `fuse.js`
- **Audio metadata:** `music-metadata`
- **Spotify client:** `@spotify/web-api-ts-sdk`
- **Logging:** `pino` (plus mirror to SQLite `logs` table for the UI)
- **Container:** single Docker image, both server and built web assets

### Widget convention

Adding a new widget is a 3-step process:

1. Create `apps/server/src/widgets/<name>/index.ts` exporting:
   ```ts
   export const widget: BackendWidget = {
     name: '<name>',
     registerRoutes(app: FastifyInstance) {
       /* ... */
     },
     registerCron(cron: CronRegistry) {
       /* optional */
     },
     bootstrapSchema(db: Database) {
       /* optional, idempotent */
     },
   };
   ```
2. Add it to the widget list in `apps/server/src/index.ts`.
3. Create `apps/web/src/routes/widgets/<name>/+page.svelte` and register a tile in `apps/web/src/lib/widgets.ts`.

The dashboard home reads `widgets.ts` and renders a tile grid linking to each widget's route. Each widget owns its own backend tables (namespaced like `music_tracker_*`).

---

## 3. Configuration

`.env` (mounted into container; example in `.env.example`):

```
# Server
PORT=8080
DATA_DIR=/data
```

Widget-specific env vars are documented in each widget's PROJECT.md.

---

## 4. Docker / deployment

Single image, multi-stage build:

1. **Build stage:** install workspace deps, build `packages/shared`, build `apps/web` (Vite static output), build `apps/server` (tsc).
2. **Runtime stage:** Node 20-slim, copy server `dist/`, copy web build into `apps/web/build`, install production deps only. Fastify serves the web static assets at `/` and the API at `/api/*`.

`docker-compose.yml` mounts:

- `./data:/data` — SQLite file, logs
- `/volume1/music/dj-library/tracks:/library:ro` — DJ library (read-only from container's perspective; rsync from PC populates this via a separate scheduled task on the NAS)

Exposes one port (default 8080). No external auth — relies on LAN-only access.

---

## 5. Conventions and quality bar

- TypeScript `strict: true` everywhere. No `any` without an inline comment justifying it.
- Shared types between server and web live in `packages/shared` and are imported by both. Don't redeclare.
- **Styles are SCSS and live in their own files — never inline in a component.** Each `.svelte` component references a sibling SCSS file via `<style lang="scss" src="./Component.scss"></style>`; Svelte still scopes those rules to the component. App-wide tokens/resets stay as `:global(...)` rules in `apps/web/src/lib/styles/global.scss`. This requires `svelte-preprocess` in `svelte.config.js` (alongside `vitePreprocess`, which silently ignores the `src` attribute), plus `sass`.
- **Use the shared design tokens.** Before any styling work, read `apps/web/src/lib/styles/global.scss` and use its CSS custom properties (`var(--space-sm)`, `var(--text)`, `var(--border)`, `var(--status-*)`, etc.) rather than hard-coding raw hex/px values. If a needed token genuinely doesn't exist, add one to `global.scss` (with light + dark values where relevant) or mirror the closest existing pattern — don't invent one-off literals.
- Database access wrapped in small typed functions (no raw SQL in route handlers). Use `better-sqlite3` prepared statements.
- Each widget's backend code is self-contained in its folder; no cross-widget imports. If two widgets need to share something, it goes in `packages/shared` or a future `apps/server/src/lib/`.
- Time stored as unix ms (`number`) in SQLite, never as strings.
- All endpoints return JSON; errors as `{ error: string, code?: string }` with appropriate HTTP status.
- No tests required for MVP. Add them when something breaks twice.

### Component design philosophy

- Prefer small, focused components over large monolithic page files.
- Any `.svelte` file exceeding **300 lines** is a good candidate for extraction — split out logical sub-units into named components.
- Components **shared across routes** live in `apps/web/src/lib/`. Components **local to a route** sit alongside the route file (e.g. `TicketCard.svelte` next to `task-monitor/+page.svelte`).
- New shared components follow the `Modal.svelte` / `Button.svelte` convention: `$props()` for inputs, `Snippet` for children, sibling `.scss` file for styles.

**Known extraction candidates** (files currently exceeding 300 lines):

- `apps/web/src/routes/task-monitor/+page.svelte` (~895 lines)

---

## 6. Build order (suggested)

1. Workspace scaffolding: root `package.json` with workspaces, `apps/server` Fastify hello-world, `apps/web` SvelteKit hello-world, `packages/shared` empty package, Dockerfile that builds and runs the whole thing.
2. Dashboard shell: home route with tile grid, widget registry mechanism on both sides, one stub widget that just says "hello" to prove the convention.
3. Music tracker schema + library scanner: just the scanner and the library table. Verify it indexes the real folder correctly.
4. Music tracker normalize + matcher: unit-testable, build against a hand-rolled fixture before plugging in Spotify.
5. Music tracker Spotify source + cron: poll, insert tracks, run matcher.
6. Music tracker frontend: Review tab first (the most-used view), then All Tracks, Manual Entry, Logs.
7. Deploy to Synology, observe matcher behavior on real data, tune thresholds.

---

## 7. Dev Tooling

Custom shell commands for operating the NAS deployment are defined in
`scripts/pd-aliases.sh`. Source that file in your shell profile to get:

- `sortie-uptime`, `sortie-healthcheck`, `sortie-refresh`, `sortie-refresh-proxy`,
  `sortie-refresh-no-proxy`, `sortie-reset <issue-id>`
- `pd-help` — prints a formatted table of all available commands with descriptions

See the migration comments at the top of `scripts/pd-aliases.sh` for NAS and Mac setup.

---

## 8. Open questions / things to revisit

- Whether `node-cron` is sufficient or if a real job queue (BullMQ) is needed — defer until a second widget with scheduling is added.

---

## 9. Glossary / Domain Language

Definitions of the domain language used across the board and the Sortie agent pipeline.
Definitions only — no implementation detail. Decisions live in `DECISIONS.md` (`D-NNN`).

### Agent pipeline

**Refine**:
The interactive session (launched from a **Refine** button on a board card) in which an
agent works *with Steve* to sharpen a ticket: it interrogates, plans, decomposes into one or
more well-shaped tickets, suggests assignments, and — after Steve's approval — creates and
routes them. Runs on a **backlog or prioritized** ticket (relaxed from prioritized-only;
amends D-044 so the Ticket Audit's "Send to Refine" can escalate a backlog finding, PD-281),
*before* a Sortie worker is dispatched. The interrogation/decomposition is just the activity
inside a Refine session — there is no separate "Grill" term.
_Avoid_: "grill" — the settled name for the whole thing (interrogation included) is **Refine**;
and don't use it for a question an agent asks mid-run (that is **ask_human**).

**ask_human**:
A question a **dispatched Sortie worker** raises mid-run when it hits real ambiguity —
it posts `### ❓ ask_human`, self-labels `sortie:awaiting-human`, parks, and resumes
after a human replies async. Clarifies the *current* ticket in place; it does **not**
produce new tickets and does **not** route anything.
_Avoid_: calling this a "refine".

**Auto-routing**:
Assigning each ticket a queue lane (**Robot's Queue** or **Steve's Queue**) and the
matching **assignee** (`robot` / `steve`). "Refine auto-routing" = doing this to the
tickets a Refine session produces.

**Autonomous agent** (e.g. a dispatched **Sortie worker**):
An agent operating *unsupervised*. **May not queue tickets** — it can create tickets into
`backlog` only (D-039). Prompt-based limits are not trustworthy for an unsupervised agent
(token-blowout risk), so queuing stays forbidden until a depth cap is enforced by
something stronger than a prompt (PD-244). This is the class D-039's backlog-only rule
governs.

**Interactive agent** (e.g. the **Refine** agent):
An agent that is *always working with Steve in the loop*. **May queue tickets — but only
after Steve's explicit approval.** Human-in-the-loop is the enforcement, so it is safe in
a way an autonomous agent is not. This is why Refine can route into queue lanes without
waiting on PD-244.

**Prioritized**:
The pre-refine triage lane — "this matters, do it next." Renames the old `ready` lane.
Refine may launch from a **backlog or prioritized** ticket (amends D-044); "Send to Refine"
on an audit finding moves a backlog ticket here as part of the handoff.

**Robot's Queue** (`robot_queue`, assignee `robot`):
The single lane for all in-flight Sortie work (collapses queued + in_progress +
in_review); the fine-grained `sortie:*` state shows as a status pill. Routing/dragging a
ticket here is the dispatch trigger.

**Steve's Queue** (`steve_queue`, assignee `steve`):
Tasks that must be done under Steve's supervision. No sub-states.

**Assignee** (`steve` | `robot` | null):
Who owns a ticket. **Optional hint pre-queue** (in backlog/prioritized Steve may set it
early when he already knows who'll do the work, or leave it null), then **forced by the
lane on queue entry** — entering `robot_queue` sets `robot`, entering `steve_queue` sets
`steve`, overriding any prior hint. The lane is authoritative once queued.

**Ticket**:
The durable spec for a unit of work, owned by the dashboard board (`agent_tickets`).
Stays amendable across its whole lifecycle (D-039).
_Avoid_: conflating with **issue**.

**Issue**:
A GitHub issue minted from a ticket at dispatch — an *execution lease*, not the durable
spec. Deletion is ticket-authoritative (D-039).

### Agent execution

> **D-055 (in progress):** the third-party **Sortie** runtime is being absorbed into `agent-worker`
> as the **Sentinel loop**. The *Sortie*-prefixed terms below (Sortie watchdog, hand-off-via-hook,
> the reaction bridges) are being retired/rehomed by that work; they stay documented until the C6
> cutover + C7 terminology sweep land.

**Sentinel**:
A **dispatched ticket-completing coding agent** — the `agent-worker` counterpart to what the
third-party Sortie runtime used to spawn (D-055). One Sentinel works one `robot_queue` ticket:
it gets a per-ticket **worktree**, runs an Agent-SDK coding session against the ticket body, and
runs the durable **hand-off** (verify → commit → push → PR → relabel). Runs as a lower-privilege
uid with **no `dashboard.db` reach** (worktree-only), which structurally enforces D-039 (a Sentinel
can't queue or self-complete). Autonomous — backlog-only ticket creation still applies.
_Avoid_: calling it "sortie" (the retired product name) or "the loop" (that's the Sentinel loop).

**Sentinel loop**:
The `sentinel` **job** in `agent-worker` (D-055) that replaces the Sortie dispatcher: polls
`robot_queue` tickets in the board DB (the DB is the queue), spawns **Sentinels** under a
concurrency cap, applies the three-tier **fault-tier** retry policy, and owns the agent-state
machine (writing DB state, pushing `sentinel:*` labels as a best-effort projection). The **sole
`dashboard.db` writer**.
_Avoid_: "the dispatcher" is fine informally, but the canonical noun is the Sentinel loop.

**run**:
One **Sentinel attempt on a ticket** (the counterpart to a Sortie "session"; recorded in the
`agent_runs` table). Retries produce further runs against the per-ticket retry cap.
_Avoid_: "session" (Sortie's term) and "sortie" (retired).

**Fault tier**:
How the Sentinel loop classifies a failed **run** (D-055), deciding whether to retry: **transient**
(no-output turn, network/CI flake → retry, per-ticket cap 3), **deterministic** (repeated identical
signature, path-guard rejection, setup fault → 0 retries, park + surface), or **system-wide**
(GitHub/Anthropic auth 401/403 → pause the whole loop + alert, zero per-ticket burn). Identical
signatures auto-promote transient→deterministic at N=2.
_Avoid_: conflating a per-ticket deterministic fault with a system-wide pause.

**agent-worker**:
The long-running process (`apps/agent-worker`, Agent SDK, out of the Fastify web process)
that **hosts LLM-agent jobs**. Owns the shared read-only repo checkout, the egress proxy,
the `ANTHROPIC_API_KEY`, and the cached project-context prefix — infrastructure every job
reuses. Coordinated with the web process via **DB rows** (the DB is the queue), not HTTP.
Renamed from "the griller worker" once it grew a second job type (PD-266 built it as
`apps/griller`; PD-281 generalizes it).
_Avoid_: calling it "the griller" — griller is one **job**, not the worker.

**Job** (agent job):
A distinct unit of agent work hosted by the **agent-worker**, e.g. **refine** (interactive,
approval-gated; the Refine session, D-044) or **audit** (autonomous, recurring; the
Ticket Audit, PD-281). Jobs share the worker's checkout/proxy/key/context-pack but have
independent trigger sources and codepaths. **Autonomy mode is a per-job property, not a
worker property** — the same worker safely hosts an interactive job and an autonomous one.

**isSortieReady**:
A Claude-free mechanical validator (`packages/shared/src/task-monitor.ts`) that checks a ticket
body carries the four required sections — `## Context` / `## Task` / `## Done When` /
`## Out of scope`. The **shape gate at queue entry**: a ticket can only enter `robot_queue`
(and decomposed robot-bound children can only be emitted) if it passes. This is the "standard
handoff shape" — no separate frontmatter schema.
_Avoid_: treating it as a quality/AI review — it is a pure structural check, not a judgement.

**Sortie watchdog**:
The in-repo Actions job (`.github/workflows/sortie-watchdog.yml`) that surfaces a job which has
run too long or stalled — it labels the issue **`sortie:stuck`** and @mentions Steve so a
capped/parked issue is *visible* rather than silently grinding. Also carries a **label-rescue**
backstop that re-applies a hand-off label the agent's turn failed to set.
_Avoid_: conflating `sortie:stuck` (watchdog, automatic) with `sortie:needs-human` (a manual
escalation) or `sortie:awaiting-human` (an **ask_human** park).

**Hand-off**:
The durable finish sequence a Sortie worker runs **in-turn** at the end of a job: `npm run verify`
→ commit → push → `gh pr create` → write `.sortie/scm.json` → relabel `sortie:in-review` (LAST).
Done in-turn (not in a hook) because the post-run hook races a context-cancel that can kill it
mid-step ([[D-046]]); the `after_run` hook is only a backstop.

**verify-ok marker**:
`.sortie/verify-ok`, written the instant `npm run verify` goes green. The one positive signal the
`after_run` safety-net trusts (the **hand-off-earned gate**, D-046): no marker ⇒ the turn ended
before a green verify ⇒ the backstop leaves the WIP for retry instead of opening a red PR.

**scm.json**:
`.sortie/scm.json` — the small record (`pr_number` / owner / repo / branch / sha) that lets
Sortie's reaction features (review-feedback / CI-failure) locate a job's PR. Regenerated by
`before_run` on a follow-up and written by the agent during **hand-off**. Gitignored (never
committed).

**Self-Review**:
The in-worker review pass (`self_review`, reviewer `"same"`) that runs **before** push/PR: it
runs `verification_commands` (`npm ci` + `npm run verify`) and lets the coding session correct
locally up to `max_iterations`. It does **not** hard-block the PR — it's a floor, not a gate.
_Avoid_: confusing with the human PR review that follows hand-off, or with the **rework bridges**.

**Rework bridge**:
An in-repo Actions workflow that re-activates a handed-off job by flipping its issue
`sortie:in-review` → `sortie:queued` so Sortie re-dispatches (`before_run` reuses the branch).
Two exist: **review-rework** (`sortie-review-rework.yml`, on trusted human PR feedback, [[D-042]])
and **conflict-rework** (`sortie-conflict-rework.yml`, on a CONFLICTING/DIRTY PR). Replaced the
native `reactions.review_comments`, which was coupled to container restarts.

**Egress proxy** (squid sidecar):
The only network route out of the egress-hardened Sortie container — a squid sidecar
(`ops/sortie/squid.conf`, reached at `egress-proxy:3128`) with a **domain allowlist**
(`.anthropic.com`, `.github.com`, `.githubusercontent.com`, `.npmjs.org`, …). Contains
token-exfil risk (PD-30) and is why git/gh/npm commands pass the proxy explicitly.

### Guardrails

Definitions for the Sortie sensitive-path guardrail model (D-047).

**Sensitive path**:
A repo path whose modification is high-risk for an unsupervised agent — CI workflows,
deploy/infra config, DB schema/migrations, dependency manifests, secrets, auth/session
code, and the harness's own config. Enumerated once in **`.github/sensitive-paths.txt`**
(the single source of truth) and consumed by both guardrail tiers. Editing a sensitive
path is never *forbidden* — it just requires an explicit human ack (see
**`sensitive-change-approved`**).
_Avoid_: conflating with "files outside the sandbox" — those are a *different*, already-solved
concern (container isolation + squid egress, PD-30), explicitly out of the guardrail's scope.

**Path-guard**:
The **Tier 1** enforcement (D-047, PD-308): a required CI check that turns a PR red when its
diff touches any **sensitive path**, unless the PR carries the **`sensitive-change-approved`**
label. Runs against the **base branch** (not the PR head) so a PR can't weaken the guard or the
list in the same change. Authoritative and **runtime-independent** — it inspects the diff, not
the agent, so it survives an agent-runtime swap.

**Guardrail tier**:
Which enforcement layer a control lives in, split by whether it survives an agent-runtime swap.
**Tier 1** = authoritative + runtime-independent (the **path-guard** at the git/GitHub boundary).
**Tier 2** = in-loop + runtime-coupled (Claude Code `permissions.deny` + a PreToolUse hook that
degrades a block to an **ask_human** park, PD-312) — early feedback / UX, re-implemented per
runtime, never the sole line of defense.
_Avoid_: treating Tier 2 as the boundary; if it's the only thing stopping a change, a runtime
swap silently removes it.

**`sensitive-change-approved`**:
The GitHub label a write+ collaborator applies to consciously ack a PR that touches a
**sensitive path**, turning the **path-guard** from red to green. Collaborator-gated (the same
trust boundary Sortie already relies on for issue labels); a stranger cannot apply it.

### Ticket relations

Definitions for the first-class ticket-relation model (D-051). A relation is a directed,
typed edge between two tickets (`agent_ticket_relations`).

**Ticket relation**:
A directed, typed edge between two tickets — `blocks` | `relates` | `duplicates` | `split`.
Stored `(from, to, type)`; `UNIQUE(from, to, type)`. `split` is the decompose lineage
(parent→child, [[D-044]]); the other three are peer links. Distinct from the *prose* a body
carries — relations are the structured, queryable truth the Audit reads ([[D-045]]).

**`blocks` relation**:
The one *behavioral* relation type. Stored `from = blocker`, `to = blocked` — "A blocked by B"
is the row `(from=B, to=A)`. Drives the **blocker gate**. The others are display-only.
_Avoid_: reading the direction backwards — the `from` side is the thing doing the blocking.

**Blocker gate**:
The rule that a ticket **cannot enter `robot_queue`** while it has an unresolved blocker — a
second queue-entry precondition beside **isSortieReady** (D-051). Hard-refused on entry; entry-only
(does not evict an already-queued ticket, but blocking a queued ticket needs a confirm). Enforced
in `updateTicket`. Cycle-safe (adding a `blocks` edge that closes a cycle is refused).
_Avoid_: treating "blocked" as merely a badge — it refuses dispatch.

**Resolved blocker**:
A blocker that no longer gates because it reached a terminal state — `completed` / `closed` /
`archived`. The four active lanes (`backlog` / `prioritized` / `robot_queue` / `steve_queue`)
still gate. "Done or gone."

**Relation origin**:
Provenance carried on each relation row — `agent` | `human` (D-051). `agent` = written by the
refine decompose or the Audit ([[D-045]]); `human` = hand-drawn in the relations UI. The column
defaults `agent` so pre-existing rows back-fill correctly. Display distinguishes them (e.g. an
agent `split` renders "auto-split 🤖", a human one "split").
_Avoid_: conflating origin with **type** — a `split` can be either origin; origin is *who made it*,
type is *what it means*.

### Epics

Definitions for the Epic umbrella primitive (D-054). An Epic groups Tickets; it is its **own**
primitive — an `is_epic` flag plus a single-parent `epic_id` column on `agent_tickets` — **not** a
relation row and **not** a tag.

**Epic**:
A Ticket flagged `is_epic` that acts as an umbrella over a set of member Tickets. Never dispatched
(cannot enter `robot_queue`); its status is **derived** from its members (hand-set only while it has
none). No nesting — an Epic cannot belong to another Epic. Members share the Epic's `project_id`.
_Avoid_: calling an Epic's members "issues" — **issue** is the GitHub lease; an Epic contains
**Tickets**. Also avoid "parent/child" for the Epic↔member link — that phrasing is reserved for
`split` lineage; an Epic *contains* Tickets / a Ticket *belongs to* an Epic.

**Epic member**:
A Ticket that belongs to an Epic via its `epic_id` (at most one Epic per Ticket). Joined/left via
the card kebab picker, the create/edit modal's epic selector, or the Epic detail page. A member
decomposed by Refine (`split`) passes its `epic_id` down to the children (the work stays under the
umbrella).

**Derived Epic status**:
A non-empty Epic's board position, computed from its members and never hand-dragged: any member in
a queue → **In Progress** (a cell spanning Steve's + Robot's queues in the Epic band); all members
`completed` (or `completed`+`closed`) → **Completed**; all `closed` → **Closed**; otherwise the
least-advanced pending lane (Backlog before Prioritized). An empty Epic defaults to Backlog and may
be hand-set until it gains a member.
_Avoid_: confusing this with a **Ticket's** hand-dragged workflow status.

**Epic roll-up**:
The `done / total` member tally shown on an Epic card (done = `completed` or `closed`).

### Dashboard shell

Definitions for the widget-grid shell and its layout affordances.

**Arrange mode**:
An editing mode, toggled by an **Arrange** button in the top-nav, in which the widget cards on the
current page become draggable (reorder) and resizable (change grid span) (D-053). It edits the
**existing auto-flow grid** — order + size only, *not* free 2D placement. Per-page overrides persist
to `localStorage` (`dashboard:layout:<pageId>`); the widget registry supplies the defaults. Available
only on widget-bearing pages at viewport ≥768px; below that the grid is a read-only single-column
reflow. "Reset to default" clears the page's override.
_Avoid_: conflating with adding/removing widgets from a page (that is the V2 **widget library**,
PD-334), or with the Task Monitor board's Kanban drag-and-drop (D-026), which is a different surface.
