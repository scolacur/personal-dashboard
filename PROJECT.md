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
- Each widget's backend code is self-contained in its folder; no cross-widget imports. If two widgets need to share something, it goes in `packages/shared` (types) or `apps/server/src/lib/` (server-side infrastructure — created by PD-442, which put the shared `job_runs` store there). Note that a shared access layer is **middleware**, not a firewall: see §9, "Firewall".
- Time stored as unix ms (`number`) in SQLite, never as strings.
- All endpoints return JSON; errors as `{ error: string, code?: string }` with appropriate HTTP status.
- No tests required for MVP. Add them when something breaks twice.

### Component design philosophy

- Prefer small, focused components over large monolithic page files.
- Any `.svelte` file exceeding **300 lines** is a good candidate for extraction — split out logical sub-units into named components.
- Components **shared across routes** live in `apps/web/src/lib/`. Components **local to a route** sit alongside the route file (e.g. `TicketCard.svelte` next to `task-monitor/+page.svelte`).
- New shared components follow the `Modal.svelte` / `Button.svelte` convention: `$props()` for inputs, `Snippet` for children, sibling `.scss` file for styles.

**Known extraction candidates** (files currently exceeding 300 lines):

- `apps/web/src/routes/devops/task-tracker/+page.svelte` (~1,103 lines) — the Kanban board. Moved
  off the Dev Ops overview by PD-421 (which was a wholesale relocation, not a rebuild), so it is
  still one large file; splitting it into components is tracked separately.
- `apps/web/src/routes/devops/tickets/[ticketId]/+page.svelte` (~735 lines)
- `apps/web/src/routes/devops/TicketCard.svelte` (~301 lines) — only just over; low priority.

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
`scripts/pd-aliases.sh`. Source that file in your shell profile to use them:

- `pd-help` — prints a formatted table of all available commands with descriptions

The old `sortie-*` container helpers (`sortie-uptime`, `sortie-healthcheck`, `sortie-refresh*`,
`sortie-reset`) targeted the now-retired Sortie container and have been removed. NAS / Robot-loop
operational helpers are tracked separately (PD-391).

See the migration comments at the top of `scripts/pd-aliases.sh` for NAS and Mac setup.

---

## 8. Open questions / things to revisit

- Whether `node-cron` is sufficient or if a real job queue (BullMQ) is needed — defer until a second widget with scheduling is added.

---

## 9. Glossary / Domain Language

Definitions of the domain language used across the board and the Robot agent pipeline.
Definitions only — no implementation detail. Decisions live one-per-file in `DECISIONS/` (`D-NNN`), indexed by the generated `DECISIONS.md` (D-070).

### Agent pipeline

**Refine**:
The interactive session (launched from a **Refine** button on a board card) in which an
agent works *with Steve* to sharpen a ticket: it interrogates, plans, decomposes into one or
more well-shaped tickets, suggests assignments, and — after Steve's approval — creates and
routes them. Runs on a **backlog or prioritized** ticket (relaxed from prioritized-only;
amends D-044 so the Ticket Audit's "Send to Refine" can escalate a backlog finding, PD-281),
*before* a Robot is dispatched. The interrogation/decomposition is just the activity
inside a Refine session — there is no separate "Grill" term.
_Avoid_: "grill" — the settled name for the whole thing (interrogation included) is **Refine**;
and don't use it for a question an agent asks mid-run (that is **ask_human**).

**ask_human**:
A question a **dispatched worker** raises mid-run when it hits real ambiguity, parking the ticket
`awaiting-human` until a human replies async. Clarifies the *current* ticket in place; it does
**not** produce new tickets and does **not** route anything. Under the Robot loop (C5/PD-346) this
is **DB-native**: the Robot writes its question to `.robot/ask-human` → the loop parks the ticket +
surfaces a Notification-Center entry; the human's reply is recorded as a `robot_human_reply` event
(not a GitHub comment), the loop re-queues the ticket, and — since the coding uid is DB-blind —
injects the Q&A into the resume prompt. (The retired Sortie path used a `### ❓ ask_human` issue
comment + `sortie:awaiting-human` label + the `sortie-ask-human` Action.)
_Avoid_: calling this a "refine".

**Auto-routing**:
Setting a ticket's lane + **assignee** (`robot` / `steve`). Under the single **Queue**
(D-058) the two are independent — routing to the queue no longer picks the worker; the
assignee does. Moot for Refine output anyway (approval never dispatches, D-057).

**Ready** (`ready` boolean, D-058):
A **computed** property — the ticket body carries the required formatting (the four
sections `## Context` / `## Task` / `## Done When` / `## Out of scope`; the check formerly
called `isSortieReady`). **Recomputed on every body edit**, so it always reflects the
*current* body — editing a Ready ticket keeps it Ready as long as the formatting survives,
and breaks it the moment a section is lost. Persisted so the loop reads a cheap flag that
can't drift (it's a pure function of the body). It is the **robot loop's hard dispatch
gate** (dispatch a robot-assigned queued ticket only if `ready || ready_bypassed`) and a
**soft gate for Steve** (he may queue a not-Ready robot ticket past a confirm modal).
Distinct from **Refine**: a Refine session *produces* Ready tickets, but a hand-formatted
ticket is equally Ready — "Ready" is about the body's shape, not about a session having run.
_Avoid_: "isSortieReady" (renamed `ready`); calling a ticket "refined" (that named a session
that ran, not a body property).

**ready_bypassed** (`ready_bypassed` boolean, D-058):
Steve's explicit, persisted override: confirming the "not Ready — output may be suboptimal"
modal when queueing a not-Ready robot ticket. Clears the loop's hard gate for that one
ticket **without** faking its `ready` state — a **separate** flag so the card shows an
honest "⚠ bypassed" badge. Moot once the body is fixed (recompute flips `ready` true).
Persists because the loop polls later.

**Autonomous agent** (e.g. a dispatched **Robot**):
An agent operating *unsupervised*. **May not queue tickets** — it can create tickets into
`backlog` only (D-039). Prompt-based limits are not trustworthy for an unsupervised agent
(token-blowout risk), so queuing stays forbidden until a depth cap is enforced by
something stronger than a prompt (PD-244). This is the class D-039's backlog-only rule
governs.

**Sub-agent depth** (D-068):
How many levels of agent-spawning-agent happen *inside one run*. Set to **zero** for the Robot: its
tool allowlist omits `Task`, so it cannot spawn sub-agents at all. Enforced mechanically (the tool is
absent from the session), never by prompt — a prompt limit is not trustworthy for an unsupervised
agent. The reason it matters is accounting: sub-agent turns carry a non-null `parent_tool_use_id` and
are **excluded from `num_turns`**, so they are invisible to the per-ticket ceiling (D-066) and to the
turns limb of the budget (D-064). The SDK offers no depth knob — the cheap options are 0 or
unbounded.
_Avoid_: bare **"depth"** anywhere in this area, and conflating this with **ticket-spawn depth** —
they share no mechanism and no enforcement point.

**Ticket-spawn depth** (`agent_queue_depth`, D-039):
How many levels of ticket-creates-ticket separate a queued ticket from a human-authored one.
Server-computed as `parent.depth + 1` and **never agent-supplied**; agent-queuing is allowed only at
`≤ 1`. About the **board**, not about a run. Still unbuilt (PD-244).
_Avoid_: reading this as a limit on sub-agents — see **sub-agent depth**.

**Interactive agent** (e.g. the **Refine** agent):
An agent that is *always working with Steve in the loop*. **May queue tickets — but only
after Steve's explicit approval.** Human-in-the-loop is the enforcement, so it is safe in
a way an autonomous agent is not. This is why Refine can route into the queue lane without
waiting on PD-244.

**Prioritized**:
The pre-refine triage lane — "this matters, do it next." Renames the old `ready` lane.
Refine may launch from a **backlog or prioritized** ticket (amends D-044); "Send to Refine"
on an audit finding moves a backlog ticket here as part of the handoff.

**Queue** (`queue`):
The single "ready to be worked" lane, collapsing the former **Robot's Queue** + **Steve's
Queue** into one (D-058, supersedes the two-lane split of D-055). Who works a queued ticket
is decided by its **assignee**, not by the lane: `assignee=robot` + `queue` + `ready`
(or `ready_bypassed`) + unblocked = **fair game for the robot loop to dispatch**;
`assignee=steve` + `queue` = Steve's personal to-do. A robot ticket's fine-grained run
state shows as a status pill. **An Epic can never enter the Queue** (barred
outright — the Epic is an umbrella, only its member Tickets are ever dispatched).
_Avoid_: "Robot's Queue" / "Steve's Queue" as *lanes* — there is one lane; those now name
the assignee-filtered *views* of it.

**Assignee** (`steve` | `robot` | null):
Who does the work — an **independent axis from the lane** (D-058, reverses D-055's
"lane forces assignee"). Set freely at any stage (a pre-queue hint or left null); it is
**no longer overwritten on queue entry**. It is the assignee — not the lane — that makes a
queued ticket robot-dispatchable. On an Epic it is a *signal only* ("the whole Epic is
robot-doable") and never dispatches, since an Epic can't be queued.

**Ticket**:
The durable spec for a unit of work, owned by the dashboard board (`agent_tickets`).
Stays amendable across its whole lifecycle (D-039).
_Avoid_: conflating with **issue**.

**Issue**:
A GitHub issue minted from a ticket at dispatch — an *execution lease*, not the durable
spec. Deletion is ticket-authoritative (D-039).

### Agent execution

> **D-055:** the third-party **Sortie** runtime has been retired and replaced by the in-house
> **Robot loop** in `agent-worker` (cutover complete). All agent state is now DB-native. See
> D-055.

**Osiris**:
The **agent control plane** (D-061) — the umbrella name covering the **Robot loop**, the queue and
dispatch model (D-058), the agent-state machine, and the Dev Ops surfaces that drive and observe
them. Names the *system*, not the repo: **personal dashboard** stays the name of the widget-hosting
project, and Osiris is the system living inside it. From the same Matrix-universe naming vein as
the harness project's Tank / Architect / Oracle — the Osiris is a Zion hovercraft, the vessel a
crew is loaded into the Matrix from, monitored while inside, and extracted back to, which is what
the control plane does with a Robot.
_Avoid_: **"Matrix"** as a name for this — it already aliases `core`/`harness` in `/harness`;
calling the whole dashboard Osiris (it is one system among the widgets); and using the codename in
public-facing or resume descriptions, which stay descriptive ("self-hosted agent platform").

**Robot**:
A **dispatched ticket-completing coding agent** in `agent-worker` (D-055). One Robot works one
`robot_queue` ticket: it gets a per-ticket **worktree**, runs an Agent-SDK coding session against
the ticket body, and runs the durable **hand-off** (verify → commit → push → PR). Runs as a
lower-privilege uid with **no `dashboard.db` reach** (worktree-only), which structurally enforces
D-039 (a Robot can't queue or self-complete). Autonomous — backlog-only ticket creation still
applies.
_Avoid_: calling it "sortie" (the retired product name) or "the loop" (that's the Robot loop).

**Robot loop**:
The `robot` **job** in `agent-worker` (D-055) that replaced the Sortie dispatcher: polls
`robot_queue` tickets in the board DB (the DB is the queue), spawns **Robots** under a
concurrency cap, applies the three-tier **fault-tier** retry policy, and owns the agent-state
machine. The **sole `dashboard.db` writer** — it pushes agent state into the DB (state is
DB-native; it no longer pushes `sentinel:*`/`sortie:*` labels).
_Avoid_: "the dispatcher" is fine informally, but the canonical noun is the Robot loop.

**run**:
One **Robot attempt on a ticket** (what the retired runtime called a "session"; recorded in the
`agent_runs` table). Retries produce further runs against the per-ticket retry cap.
_Avoid_: "session" and "sortie" (both retired terms).

**Fault tier**:
How the Robot loop classifies a failed **run** (D-055), deciding whether to retry: **transient**
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

**isReady** *(the readiness check; formerly `isSortieReady` → `isRobotReady` (C7) → now `isReady`)*:
A Claude-free mechanical validator (`packages/shared/src/task-monitor.ts`) that checks a ticket
body carries the four sections — `## Context` / `## Task` / `## Done When` / `## Out of scope`.
**D-058** makes it the definition of the persisted **`ready`** flag: recomputed on every body
write and persisted, so it always reflects the current body. The robot loop's **hard** dispatch
gate is the `ready` flag; for a human it's a **soft** hint (D-057). The mechanical check *lives* —
only the name + the recompute-on-write changed. Not a quality/AI review — a pure structural check.
_Avoid_: "isSortieReady" / "isRobotReady" in new work — the function is `isReady`, the concept is **Ready** / `ready`.

**Stall detection**:
In-process detection (`robot/stall.ts`) of a run that has gone too long or stalled: an orphaned
`working` run past the threshold is closed through the C2 fault guardrail and surfaced via the
Notification Center. DB-native — stall state lives in the DB, not in labels. **Supersedes
(C5/PD-346)** the retired external **Sortie watchdog** (`sortie-watchdog.yml`), an Actions job that
labelled the issue `sortie:stuck` and @mentioned Steve plus a label-rescue backstop; the watchdog,
its queued-staleness sweep, and label-rescue are all dropped as obsolete (the loop *is* the
dispatcher; the DB, not labels, is state).
_Avoid_: reaching for the old label-based signals — a stalled run is detected and parked in-DB, not
via a `sortie:stuck` label.

**Hand-off**:
The durable finish sequence a Robot runs **in-turn** at the end of a job: `npm run verify`
→ commit → push → `gh pr create` → write `.robot/scm.json` → mark the ticket `in-review` in-DB
(LAST). Done in-turn (not in a hook) because the post-run hook races a context-cancel that can kill
it mid-step ([[D-046]]); the `after_run` hook is only a backstop.

**verify-ok marker**:
`.robot/verify-ok`, written the instant `npm run verify` goes green. The one positive signal the
`after_run` safety-net trusts (the **hand-off-earned gate**, D-046): no marker ⇒ the turn ended
before a green verify ⇒ the backstop leaves the WIP for retry instead of opening a red PR.

**scm.json**:
`.robot/scm.json` — the small record (`pr_number` / owner / repo / branch / sha) that lets the
Robot loop's PR-state poll locate a job's PR. Regenerated by `before_run` on a follow-up and written
by the agent during **hand-off**. Gitignored (never committed).

**Self-Review**:
The in-worker review pass (`self_review`, reviewer `"same"`) that runs **before** push/PR: it
runs `verification_commands` (`npm ci` + `npm run verify`) and lets the coding session correct
locally up to `max_iterations`. It does **not** hard-block the PR — it's a floor, not a gate.
_Avoid_: confusing with the human PR review that follows hand-off, or with the **rework bridges**.

**Rework bridge**:
An in-repo Actions workflow that re-activated a handed-off job by flipping its issue
`sortie:in-review` → `sortie:queued` so the retired Sortie runtime re-dispatched. Two existed:
**review-rework** (on trusted human PR feedback, [[D-042]]) and **conflict-rework** (on a
CONFLICTING/DIRTY PR).
**Superseded (C5/PD-346):** both deleted and collapsed into one DB-native **PR-state poll**
(`robot/pr-state.ts`) — for each `in-review` ticket the loop reads the PR's review decision,
comments, and merge status via the GitHub read API and re-activates it in-DB (`agent_state=queued`),
with the reused branch + a resume-aware prompt driving the fix. Same trust model (OWNER, or
COLLABORATOR + human-reply marker); bounded by the last hand-off timestamp so stale feedback can't
re-trigger. **`robot-auto-merge.yml` stays** — a pure GitHub-side merge, no agent involvement.

**Egress proxy** (squid sidecar):
The only network route out of the egress-hardened agent-worker — a squid sidecar
(`ops/agent-worker/squid.conf`, reached at `egress-proxy:3128`) with a **domain allowlist**
(`.anthropic.com`, `.github.com`, `.githubusercontent.com`, `.npmjs.org`, …). Contains
token-exfil risk (PD-30) and is why git/gh/npm commands pass the proxy explicitly.

### Guardrails

Definitions for the sensitive-path guardrail model (D-047).

> ⚠️ **STATUS — read this before relying on anything below.**
>
> **Tier 1 (the path-guard) is LIVE (PD-308, 2026-08-04):** `.github/sensitive-paths.txt` and
> `.github/workflows/path-guard.yml` are on `main`, and `path-guard` is a **required status
> check**. Proven in both directions on real PRs before wiring — red on a sensitive diff, green
> once labelled, green on an ordinary diff. **Tier 2 is still unshipped (PD-312)** — there is no
> Claude Code `permissions.deny` and no PreToolUse hook.
>
> **Agents: Tier 1 does not stop you editing a sensitive path — it stops the PR merging
> without a human ack.** Nothing blocks the edit itself, so still treat the denylist as a rule
> you follow yourself and raise an **ask_human** rather than editing one unprompted. What you
> must NOT do is what happened in the incident below: assume a control caught something.
>
> **The 2026-08-05 author-scoping (D-067) changes nothing for you.** Steve's own PRs no longer
> need the ack; every Robot PR still does, and a `robot/*` branch is gated no matter whose
> account opened it. If you read "the guard was relaxed" and conclude your PR will sail through,
> you are repeating the #268 reasoning error below.
>
> This banner exists because of a real incident: on 2026-07-28 a Robot added a dependency to
> `apps/server/package.json` in PR #268, wrote in its PR body that "the path-guard will flag
> package.json … needs the `sensitive-change-approved` label", and merged with no such check
> ever running. It believed this section described reality. (That exact commit is now caught —
> it was used as a test case when the guard was built.)
>
> Rewrite this banner when PD-312 lands; the definitions below are otherwise accurate for
> Tier 1.

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
**Author-scoped since D-067 (PD-474):** the ack is required on every PR *except* those from an
author on the workflow's `AUTHORS_EXEMPT` allowlist (in practice Steve) — and never skipped on a
`robot/*` / `sortie/*` head branch, whoever the author is. An exempt PR still *lists* the
sensitive paths it touched in the job summary; it just reports green. The check always runs and
always reports — exemption is a green exit, never a skipped job (a `skipped` conclusion is not
what a required check expects).
_Avoid_: describing it as gating "any PR" — it gates **unsupervised-agent** PRs, which is the
population D-047 drew it against.

**Guardrail tier**:
Which enforcement layer a control lives in, split by whether it survives an agent-runtime swap.
**Tier 1** = authoritative + runtime-independent (the **path-guard** at the git/GitHub boundary).
**Tier 2** = in-loop + runtime-coupled (Claude Code `permissions.deny` + a PreToolUse hook that
degrades a block to an **ask_human** park, PD-312) — early feedback / UX, re-implemented per
runtime, never the sole line of defense.
_Avoid_: treating Tier 2 as the boundary; if it's the only thing stopping a change, a runtime
swap silently removes it.

**Firewall** (as distinct from **middleware**):
A **firewall** is a *boundary property* — it is the **only** route through, and that
unavoidability is enforced by something outside the code (process privileges, a uid, network
topology). **Middleware** is a *composition pattern* — a function in a pipeline, which a caller
can simply decline to call. A firewall is often *implemented* as middleware; the two are not
interchangeable. In this system the one thing that genuinely is a firewall is the **Robot's
DB-blind uid** (D-055): it cannot reach `dashboard.db` at all, which is what structurally
enforces D-039. A shared DB access layer in `apps/server/src/lib/` would be **middleware** —
good convention enforcement (PROJECT.md §5), not an enforcement boundary.
_Avoid_: calling a shared access layer a "DB firewall" (PD-474 direction D). A widget can always
open its own `better-sqlite3` handle, so a later reader would be trusting it for something it
cannot do. Same test for any proposed control: *can the caller decline to use it?*

**`sensitive-change-approved`**:
The GitHub label a write+ collaborator applies to consciously ack a PR that touches a
**sensitive path**, turning the **path-guard** from red to green. Collaborator-gated (the same
trust boundary the Robot loop relies on for issue labels); a stranger cannot apply it. Since
D-067 it is only ever *needed* on a gated PR — Steve's own PRs go green without one.

### Decisions

Definitions for how a decision is authored and identified (D-070, D-078). The decision *record*
is one file per decision; this covers how it gets its number.

**Allocated id** (`D-NNN`, e.g. `D-088`):
A decision's permanent identifier, handed out by the **allocation counter** *before* the decision is
written. There is no provisional stage: you ask for `D-088`, you write `DECISIONS/D-088-<slug>.md`,
and you cite `D-088` in code in the same commit. The id is real and permanent from the moment it is
returned.
_Avoid_: deriving an id by reading `DECISIONS.md` and adding one. That is the `max + 1` that produced
the duplicate D-056 and D-065 by hand, and it is exactly what the counter exists to make impossible.

**Allocation counter**:
A single row in `dashboard.db` (`decision_id_counter`), incremented inside one atomic statement. The
**only** thing that ever issues a decision id (D-088). Reached two ways, both of which end in the
same `UPDATE … RETURNING`:

- humans and scripts → **`POST /api/decisions/allocate`** → `{ "id": "D-088" }`
- Robots → **`mcp__decisions__allocate`**, an in-process tool the worker runs on their behalf

A `POST`, not a `GET`, precisely because it mutates: two callers reading *next = 88* both get 88,
which is the collision being removed. Gaps are expected and harmless — an id taken for a PR that is
abandoned is simply never used, and there is deliberately **no reclaim path**, because reuse is how
two decisions end up wearing one number.
_Avoid_: calling the Robot path "reading the DB". The worker holds the handle; the Robot asks
(D-087). `dashboard.db` remains unreadable to the coding uid.

**Why Robots use a tool and not the endpoint**:
The agent-worker container sits on an `internal: true` network whose only exit is the squid
allowlist proxy — `CONNECT` to port 443, by domain. The dashboard is plain HTTP on `:8088` at a bare
LAN IP, so it fails three separate ways. An in-process tool solves that without moving a security
boundary, which is why the firewall was left shut (D-087).

> **Retired by D-088 (PD-556):** the **decision inbox** (`DECISIONS/incoming/`), **provisional ids**
> (`D-TMP-<TICKET><letter>`), the **numbering cycle**, the repo-wide **citation rewrite**, and the
> reserved **`EG` example namespace**. All existed because an id could not be known at authoring
> time. They are gone, not deprecated — `DECISIONS/incoming/` does not exist, and a `D-TMP-` file
> written today would sit uncited forever with nothing to number it. If you find an instruction
> anywhere telling you to author one, it is stale; fix it.

**Maintenance hold**:
A **hold** kind on dispatch (alongside `session-limit` and `github-rate-limit`, D-063/D-072) that
lets a maintenance job work on shared files with no Robot mid-run: tickets stay queued, budget
untouched, resumes unattended. Bounded by the drain, which is itself bounded by `stallThresholdMs`
(~2h) since a hung run is parked rather than blocking forever. The window budgets job *starts*; a
running job is never killed (D-085).
**It currently has no jobs.** The numbering cycle was its only subscriber. The machinery is kept
deliberately — draining, bounding and releasing safely took D-081, D-082 and PD-546 to get right —
and with an empty job map it opens no *scheduled* holds, though a **manual** hold from Dev Ops still
works. Gated by `MAINTENANCE_HOLD_ENABLED`.
_Avoid_: calling it a **pause** — a pause is sticky and waits for a human (D-072), which is wrong for
an unattended window.

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
second queue-entry precondition beside **isRobotReady** (D-051). Hard-refused on entry; entry-only
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
_Avoid_: conflating with the Task Monitor board's Kanban drag-and-drop (D-026), which is a different
surface. Arrange edits *how* a page's widgets sit; **page membership** decides *which* ones are
there at all — a separate axis, and adding is deliberately available outside Arrange.

**Widget library**:
The catalogue of **all registered widgets**, independent of any page — the answer to "what widgets
exist?", never "what's on this page?". One concept, two surfaces:

- the **Library page**, reached by the **All Widgets** button at the bottom of the side nav, which
  mounts every widget **live** — you see what you would actually be adding, not a static preview.
  A **derived view, not a page**: no membership, no Arrange, no Add control, and no entry in
  `pages.ts`. "The library shows everything" is therefore true by construction rather than by
  convention — there is no surface that can remove a widget from it.
- the **Library modal**, a **toggle list** of widget *names* opened from a page's Add control.
  A checked row means the widget is on the current page; checking adds, unchecking removes. It is
  the only membership control that works below 768px, where Arrange is unavailable.

_Avoid_: treating the library as page-scoped, or as a second name for Home — Home is an ordinary
curated page like any other (PD-334), and no longer an auto-catalogue of everything. Note the
deliberate split between term and label: **library** is the domain term used in code and docs
(`LibraryModal.svelte`, the Library page), **All Widgets** is only the nav button's copy, because
"Library" alone reads vaguely beside "New Page" and "Edit". Don't rename the code to match the
button, or the button to match the code.

**Page membership**:
Which widgets are on a given page. **Entirely user state** — a widget's registration says nothing
about where it appears; registering it only puts it in the **widget library**, from which it is
placed by hand. Persisted server-side (PD-334) so a page's contents are the same on every device
and survive a cache clear, unlike the per-device *layout* override D-053 established.
_Avoid_: the retired registry field `WidgetMeta.pages` and its `widgetsForPage()` reader — the
registry no longer declares placement. Also avoid conflating membership with **layout**: membership
is *which* widgets, layout is *where and how big*.
