# Decision Log

Captures the _why_ behind key choices made during planning. Useful when revisiting a decision later — if a choice no longer fits, the original reasoning makes it easier to see what changed and whether to revisit.

Newest decisions at the top.

---

## D-038: Cmd+K shortcut uses metaKey-only (no Ctrl+K fallback) and toggles search focus (PD-126)

**Decision:** The `⌘K` keyboard shortcut on the Task Monitor board only checks `e.metaKey` (Mac Command key), not `e.ctrlKey`. Focus is toggled: pressing again while the search is focused blurs it.

**Reasoning:** The issue specifies "Mac(Command)+K". Ctrl+K is used by browsers on some platforms to focus the URL/search bar, so adding a Ctrl+K fallback could interfere. The toggle behavior (focus → blur on second press) is standard command-palette UX and avoids a second shortcut to dismiss.

**Alternative:** Support `metaKey || ctrlKey` to cover Linux/Windows. Rejected for now since this is a personal Mac-only dashboard.

---

## D-037: Deploy status uses server-start time as deploy proxy; GitHub API fetched once at startup (PD-111)

**Decision:** The home page live-status bar shows: deploy time (server process start time as proxy), git SHA linked to the GitHub commit or Actions run, and the commit message. The server fetches GitHub API exactly once at startup (fire-and-forget, cached for the process lifetime) from `apps/server/src/deploy-status.ts`. The frontend reads `/api/deploy-info` once on mount — no polling.

**Why server-start = deploy time:** Watchtower recreates the container whenever it sees a new `:latest` digest. That recreation = a fresh process start. So `Date.now()` at module load is effectively "when this image was deployed."

**Why fetch GitHub API at server startup (not at browser load):** GitHub's unauthenticated API limit is 60 req/hr shared across the host IP. Fetching once at server startup means one request per deploy regardless of how many browser sessions load the dashboard. The server caches the result and serves it indefinitely.

**Why not bake more metadata into the image:** CI/Dockerfile are off-limits per the repo's agent scope rules. `APP_VERSION` (7-char SHA) is already set by `deploy.yml`; all other metadata (commit message, Actions run URL) is derived from it via the GitHub public API at runtime.

**Alternatives considered:** polling GitHub API from the browser on each page load (hits rate limit quickly on busy days), writing a `deploy.json` sidecar file at build time (requires CI change), querying the GitHub API on every `/api/deploy-info` request (redundant after the first hit).

---

## D-036: `closed` is a separate terminal status from `completed` (PD-81)

**Decision:** Added `'closed'` as a seventh `TicketStatus` value, distinct from `'completed'`. Closed is for manually terminating a ticket for any reason other than successful completion (cancelled, won't-fix, superseded, out-of-scope). `completed` remains the agent-set terminal state (derived from GitHub via the PD-165 poller). The `closed` lane is hidden by default but can be shown via the Lanes menu.

**Alternatives considered:**
- Re-use `completed` with a wontfix badge — rejected because `completed` is externally controlled (poller-set via GitHub label), and conflating "done by agent" with "cancelled by human" muddies both the visual display and the sync logic.
- A soft-archive action — `archiveTicket` already exists for true soft-delete; `closed` is for tickets you want visible (and searchable) in the terminal lane without deleting them.

---

## D-035: Mac Mini migration mechanics — Colima, manual cutover, `.local` addressing, auto-login boot, NFS library (resolves [[D-031]]'s open items)

**Decision:** The migration mechanics [[D-031]] left "not yet designed" are settled. Lift-and-shift,
so only the host-forced changes:

- **Docker runtime: Colima** (not OrbStack, not Docker Desktop). Headless/launchd-managed, OSS (no
  licensing), explicit VM sizing on the shared 24 GB box (rec. `--cpu 6 --memory 12 --disk 100`).
  Docker Desktop needs a GUI session; OrbStack is commercial + desktop-oriented. **Re-evaluate after
  ~1 month** (P2 ticket; set a 2026-08-01 reminder once the reminders feature lands). Watchtower's
  socket mount changes under Colima (`~/.colima/default/docker.sock`, not `/var/run/docker.sock`) —
  adjust the dashboard compose.
- **Addressing: mDNS `.local` hostname, keep port 8088.** Set a stable name via
  `scutil --set HostName`. One-time sweep of hardcoded `192.168.68.50:8088` (CLAUDE.md,
  `SORTIE_BOARD_URL`, `ops/` runbooks, compose) → `<mini>.local:8088`. (8080 is free without gluetun,
  but keeping 8088 avoids gratuitous reference churn.)
- **Data cutover: manual.** Stop both stacks → `VACUUM INTO` each DB (folds the WAL — the D-025
  lesson) → transfer NAS→Mini over `ssh cat` (NAS has no SFTP subsystem) → checksum + verify (health,
  ticket count, Sortie row counts) → **keep the NAS DBs frozen as rollback** until the Mini is
  proven, then decommission. Sortie egress containment re-verified on Colima (direct = blocked,
  proxied = 200 — same Linux Docker engine inside the Lima VM, so it ports as-is; a verify item, not
  a redesign).
- **Reboot recovery: auto-login + a LaunchAgent** that starts Colima → waits for `docker info` →
  brings up the dashboard stack → then the Sortie egress stack (explicit order), with
  `restart: unless-stopped` as backstop. Colima is per-user, so unattended recovery requires a
  logged-in session → auto-login. **Trade-off accepted:** the box boots to an unlocked session
  (FileVault left off) — acceptable for an always-on LAN home server whose entire purpose is
  unattended uptime.
- **DJ library: NFS mounted directly inside the Colima VM (`:ro`), as a fast-follow** (separate
  ticket), off the critical-path cutover — music-tracker isn't wired to the real library yet.
  NFS-into-the-VM avoids the macOS-host→VM double-hop and SMB quirks; resolves D-031's "SMB/NFS"
  open choice.

**Go private stays a separate later step (P1 ticket):** flipping the repo private breaks the
currently-public GHCR pull — the Mini's pull path then needs a `read:packages` token, or the
lift-and-shift Watchtower pull fails silently.

**Why manual / lift-and-shift throughout:** a one-time personal-LAN cutover — minimize
simultaneously-changing variables and keep the proven pipeline. Re-architecting the deploy model
(local build now that the M4 can build) is deferred, per [[D-031]].

---

## D-034: Lane show/hide uses localStorage; board grid uses grid-auto-flow:column (PD-49)

**Decision:** Lane visibility preference is persisted to `localStorage` (key `agent-dashboard:hidden-lanes`) with no backend involvement. The board CSS was changed from `grid-template-columns: repeat(N, ...)` to `grid-auto-flow: column; grid-auto-columns: minmax(190px, 1fr)` so the grid adapts to any number of visible lanes without leaving empty column slots.

**Why:** The issue spec explicitly required client-side-only persistence. Implicit grid columns (`grid-auto-flow: column`) are the correct primitive here because the number of visible lanes is dynamic — an explicit `repeat(7, ...)` would create empty columns when lanes are hidden.

---

## D-033: "Refine" (PD-172) is a Claude-Agent-SDK sidecar with clone-grounded grilling and propose→approve write-back

**Decision:** The backlog→Ready "Refine" flow runs a **dedicated `refine-agent` sidecar container**
on the `egress_internal` network (mirroring Sortie), running the **Claude Agent SDK** with a
purpose-built refine prompt that reuses the `/grill-me` interview methodology — it does NOT run
`/to-issues`/`/to-sortie-issues` verbatim, since those target GitHub/tracker issues, not board
tickets. On Refine, the sidecar **shallow-clones the ticket's `github_repo` read-only** to ground the
grilling in real code (text-only fallback when `github_repo` is null). The chat streams to a modal
over **SSE** (agent→browser tokens) with a **POST per user turn**, both proxied by the dashboard
server. The agent's final output is a **structured Ready-ticket proposal**; the user edits/approves
in the modal, and the **dashboard server** (not the agent) creates the Ready tickets.

**Why:**

- **Agent SDK over a bespoke Messages-API loop or a one-shot call.** The interactive grill is the
  point of Refine; the Agent SDK provides the multi-turn tool-loop + skill execution a hand-rolled
  loop would reimplement, and a one-shot "format this ticket" call would drop the grilling entirely.
- **Sidecar over in-dashboard-server.** Isolates long-running interactive sessions + secrets
  (Anthropic key, GH token) from the Fastify web process, and reuses the containerized, egress-scoped
  pattern Sortie already established ([[D-016]]) under the egress-hardened networking of PD-7. Egress
  to `api.anthropic.com` goes through the existing squid proxy.
- **Propose→approve→server-writes over agent-writes-directly.** Keeps board-write credentials out of
  the agent (least privilege — the sidecar holds only a **read-only** GH token, for cloning), and
  bakes in a human gate structurally rather than trusting the agent to stop and ask.
- **Clone-grounded grilling.** Ungrounded refinement produces the vague, guessy tickets [[D-020]]'s
  pipeline exists to eliminate; Sortie already clones per-issue workspaces, so a read-only clone is a
  consistent, cheap way to ground ticket-slicing in real files.

**Trade-off:** A new sidecar + SSE plumbing + a clone-per-session is materially more infrastructure
than a one-shot API call — accepted because interactive, code-grounded refinement is the feature.
Session state is server-side and ephemeral: one Refine session at a time, discarded if the modal
closes before approval (no grill persistence in v1).

**Implications:** Requires an `ANTHROPIC_API_KEY` + a **read-only** GH token in the sidecar env only
(NAS `.env`, added to `.env.example`); never in the web process or browser. Depends on PD-7's
egress/networking outcome. Refine is offered on any backlog ticket; grounding degrades gracefully for
`github_repo`-null projects. See [[D-032]] for why the Claude-powered formatting lives here and not in
the Queued poller.

---

## D-032: The TODO→Sortie "Phase 3" splits — Claude formatting moves to Refine (PD-172); the Queued poller (PD-164) is mechanical and Claude-free

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
---

## D-031: Mac Mini M4 becomes the primary always-on host; NAS demotes to storage/backup appliance

**Decision:** An always-on **Mac Mini M4 (24GB)** becomes the primary host for **both the dashboard
and Sortie, migrated together in one move**. The Synology NAS demotes to a **storage/backup
appliance** — it retains the DJ library and Hyper Backup → Backblaze, but stops running the app.
**The migration happens before the branch-preview feature**; previews are deferred QOL. Migration
strategy is **lift-and-shift** (keep the GHCR-image + Watchtower-pull pipeline, change only what the
new host physically forces); re-architecting the deploy model and going private are separate later
steps.

**Why move them together (not dashboard-first):** the dashboard was never the bottleneck — it ran
fine on the NAS; **Sortie** is the workload that suffered from the weak NAS (clone storms,
CPU-bound runs). More importantly, splitting them turns the **dashboard↔Sortie link** (Mission
Control → `sortie:7678`, the P3 convert-to-issue flow, the future preview reconciler reading Sortie
state) into a **cross-machine** problem — the unresolved "reach across machines" question — which
would then have to be re-wired when Sortie eventually moved. Co-locating keeps that link on one host
/ one Docker network (localhost), so it's never wired cross-machine. Cost: a bigger, riskier cutover
(Sortie's egress-hardened squid containment, tokens, `.sortie.db`, quota-refund cron all come across
and get re-verified on Colima).

**Why:** The NAS is CPU/RAM-weak — the entire deploy pipeline is pull-based (Watchtower) precisely to
avoid building on it (see the 2026-06-30 CI/CD work). The M4 is vastly more capable: it makes ~10
concurrent branch previews feasible, is a far better Sortie host, and leaves headroom. Branch
previews were the trigger for this conversation, but the powerful host is the bigger win.

**Consequences (ripples to handle during migration — mechanics now designed in [[D-034]]):**
- Dashboard + prod `dashboard.db` move to the Mini; **DJ library becomes a network mount (SMB/NFS)**
  from the NAS for music-tracker matching.
- Backups must follow the DB to the Mini. (Tracked as PD-190 — off-box target replacing Hyper Backup;
  the consistent-snapshot job itself is [[D-029]], which is host-agnostic and ports as-is.)
- **Docker on headless macOS via Colima/OrbStack, not Docker Desktop** (which needs a GUI session).
- If the repo goes private, **GHCR pull auth breaks** — the pull path needs a `read:packages` token
  (currently public/no-auth).

**Branch previews, when built (deferred, rejected alternatives recorded so they aren't
re-proposed):** an **in-process poll-based reconciler** in the Mini dashboard (reads open PRs +
running `preview-pr-*` containers each tick, converges: start/stop/evict-oldest). Rejected:
self-hosted Actions runner (public-repo fork-code risk + event-drift), cloud preview (loses the DJ
library mount, breaks the egress-hardened posture), and dashboard-GUI-driven Docker (Fastify→Docker
socket = a security surface deliberately avoided). Previews build **locally on the Mini** (native
arm64, no GHCR push) with a **deterministic per-PR URL** so a GitHub Action links it to the ticket
without polling.

---

## D-030: Off-LAN access via Tailscale, with tailnet membership as the authentication (PD-34)

**Decision:** Reach the dashboard off-LAN over **Tailscale**, not a public reverse proxy.
Tailnet membership **is** the auth — the app stays login-less and is never publicly exposed.

**Why (over Synology RP + DDNS + Let's Encrypt, or Cloudflare Tunnel):**

- Tailscale already runs on the NAS for other apps, and the app container already publishes
  `8088` on all host interfaces, so it's reachable at `http://<nas-tailnet-name>:8088` from any
  device on the tailnet with **zero** app changes — no port-forward, no DDNS, no inbound ingress.
- The ticket requires "authentication before exposing." A public URL would mean building an app
  login (out of scope, and a standing attack surface). Tailscale makes the **tailnet the auth
  boundary** (WireGuard device identity): only my own devices can reach it, and it's never exposed.
  For a single-user personal dashboard, tailnet membership is sufficient and stronger than a
  bolt-on password. This also matches the egress-hardening security posture already in place.
- **Ports to the Mac Mini for free** — the app is moving off Synology ([[D-029]] context); Tailscale
  is just installed on the new host and the same access model holds.

**HTTPS deferred, not required:** traffic over the tailnet is already WireGuard-encrypted end-to-end,
so plain HTTP is fine. `tailscale serve` can later add a real Let's Encrypt cert on `*.ts.net`
(still private) if a secure-context browser feature (PWA/service worker) or the "not secure" label
makes it worth it. Public exposure via RP/Cloudflare only earns its complexity if the dashboard ever
needs to be shared with someone **not** on the tailnet.

**Manual (🧑) steps** (no code): confirm Tailscale + MagicDNS are up on the NAS, install/log in the
phone, hit the MagicDNS URL off-wifi. Runbook: `ops/access/README.md`.

---

## D-029: Consistent SQLite snapshots run in-process via node-cron, not a host script (PD-33)

**Decision:** Produce WAL-consistent SQLite snapshots from an **in-process `node-cron` job**
(`apps/server/src/backup.ts`, scheduled through a new `CronRegistry`), not a Synology Task Scheduler
shell script. Each run takes an online `.backup()` of the live `dashboard.db`, collapses the copy to
a **single self-contained file** (`journal_mode = DELETE`, no `-wal`/`-shm` sidecars), verifies it
with `PRAGMA integrity_check`, and writes it to `<DATA_DIR>/backups/` where the existing off-box
backup already ships it.

**Why in-process, not a host script (the `quota-refund.sh` pattern the ticket cited):**

- The app is **moving off Synology to a Mac Mini**, so anything bound to DSM Task Scheduler / host
  `/bin/sqlite3` would be throwaway. `node-cron` runs wherever Node runs → **ports with zero change**.
- It also builds the `CronRegistry` PROJECT.md §2 always specified but never had (the widget
  `registerCron` hook is now wired), which the music-tracker Spotify poller will reuse.

**Why the WAL matters (not theoretical):** the D-025 prod restore hit a 4 MB uncheckpointed WAL — a
file-level copy of the `.db` alone would have restored stale/empty data. `.backup()` + `journal_mode
= DELETE` yields one coherent file that's safe to ship and restore on its own.

**Design notes:** the module takes the DB handle and all paths as **parameters** (no module-level
`db` import) so it unit-tests without opening real data. It accepts optional **extra DB paths**
(opened read-only) so **Sortie's `.sortie.db`** can be added once the Mac Mini layout lets the runtime
reach it — scoped to `dashboard.db` for now (the precious, no-other-source-of-truth data). A snapshot
that fails verification is deleted, and pruning of old snapshots only runs **after** a good new one,
so a bad run never eats good backups. Config via env (`BACKUP_CRON`, `BACKUP_RETAIN_DAYS`,
`BACKUP_DIR`, `BACKUP_EXTRA_DB_PATHS`); defaults 03:00 daily / 14-day retention.

**Out of scope / revisit:** *shipping* snapshots off-box. On Synology, Hyper Backup → Backblaze
already carries `data/backups/`; on the Mac Mini a new off-box target (Backblaze/restic/etc.) will be
needed — orthogonal to producing the consistent file. The ticket's two 🧑 items stand while on
Synology: confirm Hyper Backup covers `/volume1/docker/`, and do one test restore.

---

## D-028: Priority is a nullable P0–P5 scale, stored under NOT NULL via a `'none'` sentinel; status locks only when agent-owned

**Decision:** Ticket priority moved from `low|medium|high` to **P0–P5** (P0 most urgent), and may be
**unset**. In the domain/API, unset is `null` (`AgentTicket.priority: TicketPriority | null`).

**Why the `'none'` sentinel (not a real NULL column):** the `agent_tickets.priority` column is
`TEXT NOT NULL`, and the migration framework ([[D-021]]) is strictly additive — it never rebuilds a
populated table. A true `NULL` would require the 12-step SQLite table rebuild, which would
**cascade-delete** every child row (relations/tags/events/reminders all FK `agent_tickets(id)
ON DELETE CASCADE`). Far too risky for a cosmetic nullability change. So unset is stored as the
string `'none'` and mapped at the store boundary: `fromDbPriority('none') → null`,
`toDbPriority(null) → 'none'`. The column stays NOT NULL; the domain still sees clean `null`.

**Data migration is a `migrate()` step, not manual API calls:** `agent_tickets_priority_to_p_levels`
remaps in-place on boot — `high→P1`; `medium` in `in_progress`/`completed`→`P3`; `medium` in
`backlog`→`'none'` (unset); `low→P4`; plus a catch-all (`NOT IN (P0..P5,'none') → P3`) so no legacy
value can survive. Runs once (ledger-guarded), atomic with the deploy, and applies to dev + prod
alike. The committed `tickets.seed.json` was **regenerated from prod** (all 260 live tickets, project
id→slug, priorities remapped by the same rules) so a fresh re-seed restores the *current* board
rather than the stale TODO-derived baseline. The seed now also carries each ticket's **display-id**
(`CreateTicketInput.displayId`): `createTicket` inserts it verbatim and advances the project's `seq`
past it (`seq = MAX(seq, n)`) so later auto-allocations don't collide — so a restore reproduces the
exact ids, not renumbered ones. `seedTickets` carries an expanded warning: the file is a
point-in-time **snapshot** and the importer is a restore-onto-empty tool, never a sync/merge over a
live board — capture the current board by regenerating from the DB, don't hand-edit and re-import.

**Status lock is assignee-gated:** a ticket's status is editable (field + drag) unless it is
**assigned to an agent AND** in `queued/in_progress/in_review/completed` (`isStatusLocked`). Chosen
over pure status-gating so the manually-managed board stays fully editable today (no assignees yet)
and the lock activates automatically once the Sortie flow assigns tickets. New tickets default to
`backlog` status and **unset** priority (assigned deliberately).

**UI:** the card priority chip is now an in-place `<select>` (P0–P5 + None) — native, so it's never
clipped by the board's overflow; an info button by the search bar opens a priority legend
(`PRIORITY_LABELS`/`PRIORITY_DESCRIPTIONS`, exported from `@dashboard/shared`); lanes still band by
priority ([[D-026]] addendum) with unset sorting to the bottom.

---

## D-027: Base PRs on `main`, not on another open PR's branch — stacking silently opts out of CI + branch protection

**Decision:** Open PRs against `main` by default. If the work depends on an unmerged PR, merge
the parent first, then branch off `main` — don't stack a PR on the parent's branch.

**Why (learned the hard way on PR #39):** CI and branch protection are both scoped to `main` only:
- `.github/workflows/ci.yml` triggers on `pull_request: branches: [main]`, so the `verify` job runs
  **only when a PR's _base_ is `main`.** A PR based on any other branch gets **no CI** — silently.
- Branch protection (required `verify` check + 1 approval) is configured **only on `main`**. A PR
  based on an unprotected branch has no rules to enforce, so GitHub shows **no merge gate and no
  "bypassing branch protection" warning** — it looks mergeable when nothing has actually checked it.

Stacking #39 on `refactor/shared-from-source` (an open PR's branch) hit both at once: green locally,
but zero CI and no gate on the PR. **Fix pattern when it happens:** retarget the base to `main`
(`gh pr edit <n> --base main`) — but retargeting fires a `pull_request: edited` event, which is
**not** in the default trigger set (`opened`/`synchronize`/`reopened`), so CI still won't run. Force
a `reopened` event with a close→reopen (`gh pr close <n> && gh pr reopen <n>`), or push a commit
(`synchronize`), to actually kick CI.

**Trade-off:** true stacked PRs (clean incremental diffs) are occasionally worth it, but only with
eyes open — the child PR is unverified and ungated until it's rebased onto `main`. Default to
flat-on-`main`.

---

## D-026: Kanban is drag-and-drop with fractional `sort_order`; `queued` lane added; status list is the single source of position

**Decision:** The Mission Control board moves tickets by native HTML5 drag-and-drop — within a
lane (reorder) and between lanes (status change) through one code path. The `◀ ▶` arrow buttons
were removed. A `queued` status/lane was added between `ready` and `in_progress`.

**Why / how it works:**
- **One drop path.** A single `ondragover` per lane finds the insertion index by comparing the
  cursor Y to each card's vertical midpoint; `onDrop` computes a new `sortOrder` by **averaging
  the two neighbours** (or stepping ±1 past the ends). `sort_order` is a SQLite `REAL`, so cards
  can be slotted between any two others indefinitely without renumbering.
- **Adding a status is a 3-line change, not a migration.** `status` is a plain `TEXT` column (no
  CHECK constraint) and API validation derives from `TICKET_STATUSES`, so `queued` needed only:
  the shared type/array (`packages/shared/src/agent-dashboard.ts`), the server `ORDER BY` CASE
  (`store.ts`), and the board's `COLUMNS`. `TICKET_STATUSES` order is the authoritative lane order,
  mirrored by the `ORDER BY` CASE — keep the two in sync when adding lanes.
- **Board UX also gained:** a live title+body search filter (`visibleTickets()`), a Condensed
  toggle (hides card bodies), and a clickable priority chip that cycles low→medium→high. `<main>`
  max-width was dropped so the 6-lane board uses full monitor width. "Mission Control" is now the
  page; "Tickets" is a titled section within it (room for future sections).

**Trade-off:** DnD is pointer-only — removing the arrows dropped the keyboard path for moving a
ticket. Acceptable for a single-user personal dashboard; revisit if keyboard/a11y is needed.

**Addendum (priority bands):** Lanes are grouped by priority — high band on top, then medium,
then low (`byStatus` sorts by `PRIORITY_RANK` then `sortOrder`). A card can only be reordered
**within its own band**: `onColumnDragOver` measures the drop point against same-priority cards
only and clamps a past-the-end drop to just before the first lower-priority card, and
`computeSortOrder` averages neighbours **within the band**. Consequence: raising a ticket to high
(via the priority chip) automatically lifts it above every medium/low ticket, because priority is
the primary sort key — no `sortOrder` change needed. Condensed view now defaults **on**.

---

## D-025: Prod self-seeds an empty board on boot (opt-in via `SEED_ON_BOOT`); dev is visually marked

**Decision:** On boot, the agent-dashboard widget runs `seedIfEmpty(db)`: if `SEED_ON_BOOT=1`
**and** `agent_tickets` is empty, it imports the committed baseline from `tickets.seed.json`. It's
gated (env flag) and guarded (empty-only + idempotent `seedTickets`), so it never fires in dev and can
never clobber a populated board. `SEED_ON_BOOT=1` is set in the **prod** `.env` (documented in
`.env.example`); dev leaves it unset. Separately, the web layout shows an amber **DEV** badge/stripe
whenever `import.meta.env.DEV` is true (i.e. under `vite dev`, never in the production build), and the
local dev DB was reset to obviously-labeled `[DEV]` dummy tickets.

**Reasoning:**

- The first prod deploy of the board came up empty because the 246 tickets only ever lived in the dev
  DB — data never syncs (the `data/` volume is gitignored and never in the image; only *code* and
  *schema migrations* propagate). We restored prod manually once; `seedIfEmpty` makes a fresh/wiped
  prod volume **self-heal to the baseline** instead of repeating that scramble.
- Opt-in + empty-only is the safety envelope: dev never auto-seeds (would fight the dummy data), and
  prod only seeds a genuinely empty table — a populated board is untouched even if the flag is on.
- The seed JSON is `import`ed (not read from disk) so esbuild inlines it into the server bundle — no
  asset to ship beside the binary, consistent with [[D-024]]. `seedTickets` is shared with the CLI
  importer (`seed/import.ts`), so there's one idempotent code path.
- The **DEV badge** addresses the root cause of "which environment am I editing?" — dev and prod are
  otherwise identical UIs. `import.meta.env.DEV` needs no env wiring and is compile-time guaranteed
  off in prod. Dummy dev data reinforces it (content itself reads `[DEV] … not prod`).

**Implications:**

- To arm prod: `SEED_ON_BOOT=1` must be in the NAS `.env` (gitignored/manual). Without it, an empty
  prod stays empty on boot — the deliberate tradeoff. It's dormant now (board has 246), firing only if
  the table is ever empty.
- Verified: empty+flag seeds 246; reboot+flag no-ops; empty without flag does nothing; full `verify`
  green.

**Revisit if:** we want prod seeding to be unconditional (drop the flag) or to re-sync from an updated
`tickets.seed.json` (would need a smarter merge than empty-only).

---

## D-024: `@dashboard/shared` is consumed from source (no build, no `dist`); the server is esbuild-bundled

**Decision:** `packages/shared` is no longer built to `dist/` and consumed as a compiled package.
It's a **source-only** package (`main`/`types`/`exports` all point at `./src/index.ts`, no `build`
script) and every consumer resolves its **source**:

- **Web** (`apps/web`): `svelte.config.js` `kit.alias` maps `@dashboard/shared` → `../../packages/shared/src/index.ts`, which wires both Vite and the generated tsconfig. Vite bundles the source in dev *and* prod.
- **Server** (`apps/server`): built with **esbuild** (`apps/server/build.mjs`) into a single CJS bundle. `packages: 'external'` keeps all npm deps out of the bundle (crucially `better-sqlite3`'s native `.node` binary), and an esbuild `alias` rewrites `@dashboard/shared` to its source so it's the one dependency inlined.
- **Server dev/typecheck** (`tsx`, `tsc --noEmit`): resolve shared via its `package.json` `types`/`exports` → `src/index.ts`.

This **supersedes [[D-019]]** (there is no `dist` to rebuild, so the rebuild-after-edit gotcha is gone)
and **reverts [[D-023]]** (NodeNext + explicit `.js` extensions were only needed for Node to load the
built `dist/` at runtime — which no longer happens; shared is back to extensionless imports +
`moduleResolution: Bundler` for its own typecheck).

**Reasoning:**

- Modeled on Splice's `surfaces/apps/web-svelte`, which has **no `dist` for internal libs** — it resolves them from source via `tsconfig.base.json` paths wired into Vite/svelte-kit. Bundlers inline the source; nothing is handed to Node's native loader as a pre-built package. That architecture simply doesn't have the class of bug we kept hitting.
- Both of our `dist`-era bugs came from the gap between *bundler* resolution (lenient) and *Node's native ESM loader* (strict): D-019's stale-`dist` browser crash and D-023's extensionless-import `ERR_MODULE_NOT_FOUND`. Consuming source through bundlers everywhere (Vite, esbuild, tsx) closes that gap — the strict Node loader is never in the path for shared.
- D-019 rejected a dev-only src alias to preserve dev/prod parity. That objection is now moot: the alias is **unconditional** (dev and prod both bundle source), so there's no divergence — the exact thing D-019 wanted, achieved the other way.

**Implications:**

- **Verified end-to-end:** full `verify` green (shared typecheck, web `svelte-check`, server `tsc`, lint, 52 + 16 tests); the **esbuild server bundle boots** (`/api/health` ok) with `packages/shared/dist` deleted and `better-sqlite3` loading natively; `tsx` dev and `vite dev`/build both resolve source.
- **Dockerfile simplified:** no `shared` build step, no `shared/dist` copy. The server bundle is self-contained except for external npm deps (still shipped via the pruned `node_modules`).
- **Tradeoff / dependency:** shared is now only consumable by a **bundler-or-transpiler** (Vite, esbuild, tsx, vitest) — never by plain `node` against a bare `@dashboard/shared` import. If some future entry point needs to `node`-run code that imports shared without bundling, either bundle it too or reintroduce a build. `better-sqlite3` (and any native dep) must stay in esbuild's `external` set.

**Revisit if:** we add a Node entry point that imports shared without going through esbuild/tsx (then bundle it or give shared a build again).

---

## D-023: `packages/shared` emits Node-resolvable ESM (NodeNext + explicit `.js` extensions + `exports` map)

> **Reverted by [[D-024]]:** shared is no longer built or loaded by Node at runtime (the server is
> esbuild-bundled and inlines shared source), so the NodeNext + `.js`-extension packaging this
> decision added is no longer needed. Kept for the record — the root-cause analysis of *why* extensionless
> ESM breaks Node's native loader still stands and is exactly why D-024's bundle-everything approach is safe.

**Decision:** `packages/shared` is compiled with `"module": "NodeNext"` / `"moduleResolution":
"NodeNext"` (was `ESNext` / `Bundler`), its source uses **explicit `.js` extensions** on relative
imports (`export … from './agent-dashboard.js'`), and its `package.json` declares an `exports` map
(`"." → { types, default }`) alongside `main`/`types`. It stays a single **ESM** package (browser
consumption still requires ESM — see [[D-019]]). The CommonJS server (`tsc` → `node dist/index.js`)
loads it via Node's stable `require(ESM)` (Node ≥20.19; the runtime image is `node:20-slim`).

**Reasoning:**

- **This is what broke prod** (MODULE_NOT_FOUND on deploy). Under `moduleResolution: Bundler`, tsc
  emitted **extensionless** re-exports (`export … from './agent-dashboard'`). Bundlers (Vite for web,
  vitest, esbuild) resolve those fine, so dev/CI were green — but **Node's native ESM loader requires
  file extensions**, so the moment the server imported `@dashboard/shared` at runtime it threw
  `ERR_MODULE_NOT_FOUND` on the internal `./agent-dashboard` import. This is exactly the dev/prod
  divergence [[D-019]] flagged, now biting from the runtime side.
- **Why it only broke recently:** [[D-019]] noted "the server imports `@dashboard/shared` only in a
  `.spec.ts`, never at runtime." That stopped being true when the agent-dashboard widget shipped —
  `routes.ts` imports the *values* `TICKET_STATUSES`/`TICKET_PRIORITIES` (not just types), which emits
  a real `require('@dashboard/shared')`. First prod boot with that widget → crash. (`store.ts` uses
  `import type` only, so it's erased and doesn't count.)
- **NodeNext + `.js` extensions is the standards-compliant fix.** The emitted `./agent-dashboard.js`
  resolves under Node's ESM loader, and every bundler consumer (Vite/vitest/svelte-check) handles
  explicit extensions transparently — so it's correct everywhere, no divergence. The `exports` map is
  packaging hygiene (modern resolvers use it; `main` remains for older ones).
- **Not the web adapter.** The reported symptom looked like a "dist vs build" problem, but `apps/web`
  already does the right thing: `@sveltejs/adapter-static` writes to `apps/web/build/` (gitignored,
  built in the Dockerfile, served by Fastify). The break was entirely in the shared package's module
  format, not the web output directory.

**Implications:**

- Verified by **booting the built server** (`node apps/server/dist/index.js`) against a temp data dir
  and hitting `/api/health` — the real prod path, not just a bundler build. CI/`verify` builds but
  never boots the server, which is precisely why this class of bug shipped ([[D-019]]'s open revisit
  note). **Recommended guard:** a smoke test that boots the compiled server and curls `/api/health`,
  wired into the Dockerfile build stage or CI, so a runtime-load regression fails the build.
- Depends on Node ≥20.19 (`require(ESM)`); the runtime is pinned to `node:20-slim`. If that ever
  regresses below 20.19, either dual-build `shared` (CJS+ESM via an `exports` `require`/`import` split)
  or convert the server to ESM.

**Revisit if:** the server moves to ESM (then it imports `shared` natively, no `require(ESM)`), or Node
drops below 20.19 in the image (dual-build `shared`).

---

## D-022: Widget-only logic lives with its widget, not in `packages/shared`; `apps/web` has its own test runner

**Decision:** `packages/shared` is reserved for code that genuinely crosses the client/server
boundary — the request/response *types* the server serves and the web fetches (e.g. `AgentTicket`,
`CreateTicketInput`). Pure logic used by **only one side** now lives with its consumer. Concretely,
the Pomodoro timer logic (`formatTime`, `advancePhase`, `clampRoundsBeforeLongBreak` + its types)
moved from `packages/shared/src/pomodoro.ts` to
`apps/web/src/routes/widgets/pomodoro/timer-logic.ts`, next to `PomodoroTimer.svelte`, and `apps/web`
gained its own vitest setup (`vitest` devDep + `test` script + an isolated `vitest.config.ts` with no
SvelteKit plugin). This supersedes the pomodoro half of [[D-018]] and closes [[D-017]]'s open
follow-up ("shared logic tested indirectly from `apps/server/src`").

**Reasoning:**

- `pomodoro.ts` was never actually shared. Its only runtime consumer was the web component; the only
  other importer was a *test file* in `apps/server`. It lived in `shared` purely so the server's
  vitest could reach it — because `apps/web` had no test runner. That is a testing-infrastructure gap
  leaking into architecture (the tail wagging the dog): a single-purpose, web-only module was placed
  in a cross-cutting package for test access, not because anything on the server used it.
- The honest fix is to give `apps/web` a test runner and keep widget logic with its widget. Colocated
  logic is easier to find, and it shrinks the "rebuild `shared` after every edit" gotcha ([[D-019]]) —
  widget logic changes far more often than the shared wire types do, so keeping it out of `shared`
  means fewer forced `shared` rebuilds mid-dev.
- The rule going forward: **shared = types/values on the wire between server and web. Everything else
  lives with its consumer.** If two *runtime* consumers ever need the same logic, promote it to
  `shared` (or a future `apps/server/src/lib/`) then — not preemptively.

**Implications:**

- `apps/web` now runs `vitest run` (16 Pomodoro tests moved over); root `npm run test` runs both the
  server and web suites, so `npm run verify` covers both.
- **Both workspaces are pinned to the same vitest, `^4.1.9`** (was `^3.2.6`). This matters because of
  a Vite-version skew: `vitest@3.2.6` peers on Vite ≤7, but `apps/web` is on Vite 8, so under 3.2.6
  npm nested a second Vite (7.x) under `vitest`, and `svelte-check` errored on the two copies'
  conflicting global `ImportMeta` augmentation. `vitest@4.1.9` peers `^6 || ^7 || ^8`, so it dedupes
  to the single Vite 8 already installed — no nested copy, no type conflict, and specs are type-checked
  by `svelte-check` normally (no tsconfig `exclude` workaround needed). Keep the two workspaces on the
  same vitest major to avoid reintroducing a duplicate Vite.

**Revisit if:** a piece of widget logic genuinely gains a second runtime consumer on the other side of
the wire — promote it to `packages/shared` at that point.

---

## D-021: Non-destructive migration framework — schema only ever grows

**Decision:** All Agent Dashboard schema evolution goes through a small migration framework
(`apps/server/src/migrate.ts`): a `_migrations` ledger table, a `migrate(db, id, fn)` runner that
executes each step once inside a transaction and records it, and additive helpers `columnExists` /
`addColumn`. Migrations may **create tables or ADD columns — never drop or recreate**. `CREATE TABLE
IF NOT EXISTS` statements carry the full current schema (so fresh DBs are complete in one shot); the
`addColumn` migrations bring pre-existing tables up to date and are no-ops on a fresh DB.

**Reasoning:**

- Steve's explicit requirement: "it is inevitable that we will need to update the data model as we
  go along… I want to be sure we can do so safely without getting rid of existing data." The prior
  approach (`CREATE TABLE IF NOT EXISTS` only) safely adds *new tables* but silently fails to evolve
  an *existing* table (won't add a column), and a drop/recreate would destroy data.
- Append-only migrations + a ledger make evolution deterministic and idempotent: a step runs at most
  once, a failed step rolls back (transaction) and retries next boot, and shipped migrations are
  never edited — you add new ones. This is the durable complement to the off-box Backblaze backups
  (the HIGH `SQLite backup` TODO): backups protect against loss, migrations protect against
  destructive change.

**Implications:** Adding a field later is a one-line `addColumn` migration, no data risk. Proven in
this build: `project_id`, `display_id`, `archived_at`, `assignee`, `recur_interval`, and
`agent_projects.key`/`seq` were all added to a pre-existing `agent_tickets`/`agent_projects` without
data loss.

---

## D-020: Cross-project ticket backlog (`agent_tickets` + `agent_projects`), distinct from D-014 agent-run tables

**Decision:** The Agent Dashboard is a **cross-project** Kanban — it tracks TODOs for *all* Steve's
projects (personal-dashboard, core, nervous-system-website, …), not just the dashboard. Backed by
dashboard-owned tables: `agent_projects` (with a display-id `key` like `PD`/`C`/`NSW`, `github_repo`,
`sortie_enabled`, `color`) and `agent_tickets`, plus `agent_ticket_relations` (blocks/relates/duplicates),
`agent_tags` + `agent_ticket_tags`, `agent_ticket_events` (activity log), and `agent_ticket_reminders`.
Five statuses map to columns: `backlog`/`ready` set **manually**; `in_progress`/`in_review`/`completed`
**derived** from GitHub once a TODO is converted to a Sortie issue, cached on the row. This is Phase 1
of the TODO → Sortie-issue pipeline (Kanban now; seed-import Phase 2; Claude-API "Convert to issue" Phase 3).

**Reasoning:**

- **Does not conflict with D-014.** D-014 put the agent *run* tables (`agent_jobs`, `agent_errors`,
  `agent_inbox`, `agent_schedule`) in the agent runner (Sortie's `.sortie.db`), dashboard as
  read-only consumer. `agent_tickets` is Steve's *backlog*, owned by the dashboard, predating any run.
  The dashboard only *reads/caches* run-state for the derived statuses.
- **Derived statuses come from GitHub labels, not the Sortie API.** The `sortie:*` labels are the
  state machine (see `ops/sortie/WORKFLOW.md`). Polling GitHub needs no new infra and avoids coupling
  to Sortie's `:7678` API (on an `internal: true` network, no host route).
- **Per-project display IDs** (`PD-7`, `C-3`) via integer PK + a `display_id` string (not UUID —
  single-node SQLite gains nothing from UUID and loses readability). `agent_projects.seq` is bumped
  per create; numbers are never reused.
- **Relations generalized** (one table + `type`) so `relates`/`duplicates` need no new table.
  **Soft-delete** (`archived_at`) keeps deletes recoverable (data-safety). **Tags** normalized so
  they're addable/renamable. **Activity log** feeds the agent-dashboard spec's future Activity Feed.
- **Seed then archive (not delete).** Phase 2 parses each repo's `TODO.md`/`META-TODOS.md` (completed
  "Shipped" items seeded as `completed`) into a committed seed JSON + importer, then the source files
  are **renamed `TODO-<domain>.md` and moved to `/Users/steve/Documents/Dev/archive/`** — out of the
  repos (git history retains them) but preserved on disk (Backblaze-backed). The DB is then the single
  source of truth.

**Implications:** Only backlog/ready are hand-set; the derived three wire to GitHub polling in Phase 3.
Frontend for relations/tags/reminders/recurring/assignee/drag-reorder/Activity-Feed is deferred to
follow-up cards; the schema reserves all of it now. The board is a *page* (`/agent-dashboard`), not a
home-tile widget.

---

## D-019: `packages/shared` emits ESM; `dev` does not auto-build it (rebuild-after-edit is manual)

> **Superseded by [[D-024]]:** `shared` is no longer built to `dist/` at all — it's consumed from
> source by every bundler/transpiler (Vite, esbuild, tsx). There is nothing to rebuild after editing,
> so this decision's central "rebuild-after-edit is manual" gotcha no longer exists. (Historical note:
> the `moduleResolution: Bundler` + extensionless imports below is what [[D-023]] later had to work
> around for Node runtime loading — a problem D-024 removes by never loading shared through Node.)

**Decision:** `packages/shared` is an **ESM** package — `"type": "module"` in its `package.json` and `"module": "ESNext"` / `"moduleResolution": "Bundler"` in its `tsconfig.json` (was `"module": "CommonJS"`). Separately, we deliberately do **not** wire a shared build/watch into `npm run dev`: after editing `packages/shared/src`, you must rebuild it (`npm run build -w packages/shared`, or just `npm run verify`, which builds first) before the web dev server reflects the change.

**Reasoning:**

- **The CommonJS output crashed the browser.** The web app (`apps/web`, Svelte/Vite) imports `@dashboard/shared` at runtime (the Pomodoro widget — see [[D-018]]). With CommonJS output, `dist/index.js` was `Object.defineProperty(exports, …)`; Vite's dev server serves modules to the browser as native ESM, where `exports` is undefined → **"exports is not defined"**. ESM output (`export …`) is consumable by both the browser (web) and Node/vitest (server).
- **Switching to ESM is safe for the server.** `apps/server` imports `@dashboard/shared` only in a `.spec.ts` (vitest, which handles ESM natively) — never at runtime — so the server's CommonJS build/run path is unaffected. `moduleResolution: Bundler` lets the extensionless `./pomodoro` import emit as-is; Vite and vitest both resolve it.
- **Why CI didn't catch the bug.** `npm run verify` builds → typechecks → lints → unit-tests, but never boots the dev server or loads a page in a browser. The failure was *dev-mode-only*: `vite build` (prod) bundles via Rollup, whose commonjs plugin transparently converts CJS→ESM, so the production build was green even with CJS output. CI also always builds `shared` from source, so the *stale-`dist/`* half of the problem (local `dist/` predating the Pomodoro code) can't occur in CI either.
- **Why not auto-build shared in `dev`.** Considered three options (a `predev` build-once, a `tsc --watch` process in `concurrently`, and aliasing Vite to `shared/src`). Chose none. `shared` is small and edited infrequently (types + a few pure functions); the pain is real but rare and almost always the "stale `dist/` at startup" case. A `predev` build-once would create a false sense of liveness (mid-session edits still go stale); `tsc --watch` HMR through the symlinked workspace dep is finicky and adds a process; aliasing to `src` would make dev resolve source while prod resolves `dist` — re-hiding exactly the dev/prod divergence that produced this bug. Keeping the manual build preserves dev↔prod parity (both consume `dist/`) and the local signal that comes with it.

**Implications:** The "rebuild `shared` after editing" step is a known manual gotcha, not an oversight. Builds on [[D-017]]'s open follow-up (`packages/shared` still has no vitest config of its own; shared logic is tested indirectly from `apps/server/src`).

**Revisit if:** `shared` starts being edited frequently while `dev` is running and the manual rebuild becomes a recurring annoyance — then add `tsc --watch` (plus a `predev` build-once to cover cold starts), or give CI a dev-mode smoke test (load `/`, assert no console errors) to catch this class of bug.

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
