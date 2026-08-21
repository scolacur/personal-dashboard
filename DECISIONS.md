# Decision Log

Captures the _why_ behind key choices made during planning. Useful when revisiting a decision later — if a choice no longer fits, the original reasoning makes it easier to see what changed and whether to revisit.

**This file is generated — do not edit it by hand.** Each decision is its own file in `DECISIONS/`;
this is the index over them. To add one, write a new `DECISIONS/D-NNN-slug.md` and run
`npm run decisions:index`. Writing a file instead of appending here is what lets two agents log
two decisions without touching the same lines (D-070).

Newest first.

---

- **[D-078](DECISIONS/D-078-decisions-authored-provisionally-numbered-in-cycles.md)** — Decisions are authored with a provisional id and numbered in a daily cycle behind a maintenance hold (PD-498)
- **[D-077](DECISIONS/D-077-session-memory-inbox-wrap-up-owns-index.md)** — A human session writes to the memory inbox too, and `MEMORY.md` becomes a wrap-up-only write (PD-513)
- **[D-076](DECISIONS/D-076-evaluator-is-not-oracle-post-pr-own-ledger.md)** — The Evaluator is not Core's Oracle — it runs post-PR, on its own ledger, and reaches the Robot through the DB (PD-487)
- **[D-075](DECISIONS/D-075-worker-fetches-docs-not-the-agent.md)** — The worker fetches documentation, not the agent — and the URL is the channel that needed closing (PD-310)
- **[D-074](DECISIONS/D-074-job-run-outcome-belongs-in-the-schema.md)** — A job run's outcome belongs in the schema, not in its message
- **[D-073](DECISIONS/D-073-page-membership-user-state-not-registry.md)** — Page membership is user state in the DB, not a registry field; the widget registry declares no placement at all (PD-334)
- **[D-072](DECISIONS/D-072-github-rate-limit-is-a-hold-not-a-pause.md)** — A GitHub rate limit holds dispatch; only a broken credential pauses it (PD-248)
- **[D-071](DECISIONS/D-071-robot-orientation-injected-memory-per-run.md)** — The Robot's orientation is injected, not fetched — and its memory is one file per run (PD-306)
- **[D-070](DECISIONS/D-070-one-decision-per-file-generated-index.md)** — One decision per file, with a generated index and a duplicate-id test as the real guard (PD-490)
- **[D-069](DECISIONS/D-069-arrange-mode-drag-reorder-uses-native.md)** — Arrange mode drag-to-reorder uses native HTML5 DnD (commit-on-drop) rather than `svelte-dnd-action` (PD-331)
- **[D-068](DECISIONS/D-068-robot-tool-allowlist-no-sub-agents.md)** — The Robot's tools are an explicit allowlist, and it may not spawn sub-agents (PD-486)
- **[D-067](DECISIONS/D-067-path-guard-gates-unsupervised-agents-steve.md)** — The path-guard gates unsupervised agents, not Steve — author-scoped, with a Robot-branch backstop (PD-474; amends D-047)
- **[D-066](DECISIONS/D-066-ticket-may-raise-own-turn-ceiling.md)** — A ticket may raise its own turn ceiling, bounded — and decomposing stays preferred
- **[D-065](DECISIONS/D-065-bst-list-gear-duplicates-legal-matcher.md)** — The BST list is gear, duplicates are legal, and the matcher is tuned for precision
- **[D-064](DECISIONS/D-064-loop-wide-budget-ceiling-counts-turns.md)** — The loop-wide budget ceiling counts turns per rolling 24h, and pauses deliberately
- **[D-063](DECISIONS/D-063-session-limit-holds-loop-expires-itself.md)** — A session limit holds the loop and expires itself; it never parks a ticket
- **[D-062](DECISIONS/D-062-widget-card-links-dedicated-page-does.md)** — A widget card links to a dedicated page; it does not flip
- **[D-061](DECISIONS/D-061-agent-control-plane-named-osiris.md)** — The agent control plane is named **Osiris**
- **[D-060](DECISIONS/D-060-shared-spotify-client-uses-custom-confidential.md)** — The shared Spotify client uses a custom confidential-client refresh-token auth strategy and no-ops (never throws) when unconfigured (PD-377, slice 1/3)
- **[D-059](DECISIONS/D-059-epic-area-drag-resize-uses-css.md)** — Epic area drag-to-resize uses a CSS custom property driven by a pointer-capture handle; height persisted to `localStorage` (#249)
- **[D-058](DECISIONS/D-058-one-lane-assignee-decides-dispatch-computed.md)** — One `queue` lane (assignee decides dispatch); `ready` (computed formatting) is the single dispatch gate with an explicit bypass; Epics are barred from the queue and get a `Populate` refine mode (PD-390, PD-377, PD-382)
- **[D-057](DECISIONS/D-057-refine-approval-never-dispatches-split-approve.md)** — Refine approval never dispatches — split "Approve" from "Approve & queue"; `isSortieReady` is a soft hint (PD-377)
- **[D-056](DECISIONS/D-056-pomodoro-interval-settings-shared-draggable-bar.md)** — Pomodoro interval settings as a shared draggable bar-graph component (`IntervalBars`) rather than duplicated `<input type="number">` rows (#235)
- **[D-055](DECISIONS/D-055-retire-third-party-sortie-runtime-absorb.md)** — Retire the third-party Sortie runtime — absorb dispatch into `agent-worker` as the **Sentinel loop**; board DB becomes the agent-state machine (PD-323/PD-231/#220)
- **[D-054](DECISIONS/D-054-epics-first-class-umbrella-primitive-distinct.md)** — Epics are a first-class umbrella primitive (`is_epic` + `epic_id`), distinct from `split`; status is derived and rendered in a non-draggable board band (PD-318)
- **[D-053](DECISIONS/D-053-widget-arrange-mode-edits-existing-auto.md)** — Widget "Arrange" mode edits the existing auto-flow grid (reorder + resize) with per-page `localStorage` overrides — not free 2D placement, not DB persistence (PD-331)
- **[D-052](DECISIONS/D-052-auto-merge-bridge-keys-off-specific.md)** — Auto-merge bridge keys off `mergeStateStatus == CLEAN`, not specific check names (PD-211)
- **[D-051](DECISIONS/D-051-ticket-relation-hard-entry-gate-second.md)** — A `blocks` ticket relation is a **hard `robot_queue`-entry gate** (a second queue-entry precondition beside `isSortieReady`); relations carry an `origin` (agent|human); PD-156 sliced backend→frontend (PD-156)
- **[D-050](DECISIONS/D-050-embedded-live-widgets-use-registry-provided.md)** — Embedded live widgets use a registry-provided component + span; generic card is shared chrome (PD-207)
- **[D-049](DECISIONS/D-049-acute-strategies-generator-uses-client-side.md)** — Acute Strategies Generator uses client-side filtering and randomisation (PD-202)
- **[D-048](DECISIONS/D-048-acute-strategies-generator-stores-tags-json.md)** — Acute Strategies Generator stores tags as a JSON array in a SQLite TEXT column (PD-202)
- **[D-047](DECISIONS/D-047-sortie-sensitive-path-guardrails-two-tier.md)** — Sortie sensitive-path guardrails are two-tier — an authoritative, runtime-independent CI path-guard (Tier 1) plus a runtime-coupled in-loop Claude Code layer (Tier 2), both fed by one shared denylist (PD-308, PD-312; supersedes C-2, PD-13, C-15)
- **[D-046](DECISIONS/D-046-sortie-after-run-safety-net.md)** — Sortie's `after_run` safety-net publishes a hand-off ONLY when the agent earned it (a green-verify marker), never a mid-work tree (PD-299)
- **[D-045](DECISIONS/D-045-ticket-audit-autonomous-recurring-agent-worker.md)** — The Ticket Audit is an autonomous, recurring **agent-worker** job that produces sticky, human-approved recommendations over the backlog — read-only run, human-gated apply, verify-and-confidence-gated for trust (PD-281)
- **[D-044](DECISIONS/D-044-grill-refine-dashboard-owned-interactive-async.md)** — Grill/Refine is a dashboard-owned, interactive, async triage agent launched from a "Refine" button — reinstating an interactive Refine step (reverses [[D-038]]'s drop) but async-over-notifications, not [[D-033]]'s synchronous SSE modal (PD-172, PD-245, PD-250, PD-255)
- **[D-043](DECISIONS/D-043-board-reflects-github-changes-via-demand.md)** — Board reflects GitHub changes via an on-demand sync trigger (page-load + "Sync now"), not just the once-a-minute cron (PD-252)
- **[D-042](DECISIONS/D-042-sortie-review-re-work-moves-from.md)** — Sortie review re-work moves from the native `reactions.review_comments` to an in-repo Actions bridge (PD-256)
- **[D-041](DECISIONS/D-041-cmd-k-shortcut-uses-metakey-only.md)** — Cmd+K shortcut uses metaKey-only (no Ctrl+K fallback) and toggles search focus (PD-126)
- **[D-040](DECISIONS/D-040-agent-widget-notifications-go-through-dashboard.md)** — Agent + widget notifications go through a dashboard-native Notification Center with a pluggable delivery transport; web push is primary, Discord is demoted to an optional adapter (PD-6, PD-142, PD-242, PD-243)
- **[D-039](DECISIONS/D-039-board-issue-authority-ticket-durable-spec.md)** — Board↔issue authority — ticket is the durable spec, issue is an execution lease; ticket stays amendable post-queue; agent-created tickets are backlog-only, queuing gated by a server-computed depth cap (PD-207, PD-232)
- **[D-038](DECISIONS/D-038-issue-pipeline-hybrid-mechanical-gate-async.md)** — Issue pipeline is hybrid — mechanical `isSortieReady` gate + async in-run grill via `ask_human`; the heavyweight Refine sidecar (D-033) is dropped (PD-232)
- **[D-037](DECISIONS/D-037-deploy-status-uses-server-start-time.md)** — Deploy status uses server-start time as deploy proxy; GitHub API fetched once at startup (PD-111)
- **[D-036](DECISIONS/D-036-separate-terminal-status-from.md)** — `closed` is a separate terminal status from `completed` (PD-81)
- **[D-035](DECISIONS/D-035-mac-mini-migration-mechanics-colima-manual.md)** — Mac Mini migration mechanics — Colima, manual cutover, `.local` addressing, auto-login boot, NFS library (resolves [[D-031]]'s open items)
- **[D-034](DECISIONS/D-034-lane-show-hide-uses-localstorage-board.md)** — Lane show/hide uses localStorage; board grid uses grid-auto-flow:column (PD-49)
- **[D-033](DECISIONS/D-033-refine-pd-172-claude-agent-sdk.md)** — "Refine" (PD-172) is a Claude-Agent-SDK sidecar with clone-grounded grilling and propose→approve write-back
- **[D-032](DECISIONS/D-032-todo-sortie-phase-3-splits-claude.md)** — The TODO→Sortie "Phase 3" splits — Claude formatting moves to Refine (PD-172); the Queued poller (PD-164) is mechanical and Claude-free
- **[D-031](DECISIONS/D-031-mac-mini-m4-becomes-primary-always.md)** — Mac Mini M4 becomes the primary always-on host; NAS demotes to storage/backup appliance
- **[D-030](DECISIONS/D-030-off-lan-access-via-tailscale-tailnet.md)** — Off-LAN access via Tailscale, with tailnet membership as the authentication (PD-34)
- **[D-029](DECISIONS/D-029-consistent-sqlite-snapshots-run-process-via.md)** — Consistent SQLite snapshots run in-process via node-cron, not a host script (PD-33)
- **[D-028](DECISIONS/D-028-priority-nullable-p0-p5-scale-stored.md)** — Priority is a nullable P0–P5 scale, stored under NOT NULL via a `'none'` sentinel; status locks only when agent-owned
- **[D-027](DECISIONS/D-027-base-prs-another-open-pr-s.md)** — Base PRs on `main`, not on another open PR's branch — stacking silently opts out of CI + branch protection
- **[D-026](DECISIONS/D-026-kanban-drag-drop-fractional-lane-added.md)** — Kanban is drag-and-drop with fractional `sort_order`; `queued` lane added; status list is the single source of position
- **[D-025](DECISIONS/D-025-prod-self-seeds-empty-board-boot.md)** — Prod self-seeds an empty board on boot (opt-in via `SEED_ON_BOOT`); dev is visually marked
- **[D-024](DECISIONS/D-024-consumed-from-source-no-build-no.md)** — `@dashboard/shared` is consumed from source (no build, no `dist`); the server is esbuild-bundled
- **[D-023](DECISIONS/D-023-emits-node-resolvable-esm-nodenext-explicit.md)** — `packages/shared` emits Node-resolvable ESM (NodeNext + explicit `.js` extensions + `exports` map)
- **[D-022](DECISIONS/D-022-widget-only-logic-lives-widget-has.md)** — Widget-only logic lives with its widget, not in `packages/shared`; `apps/web` has its own test runner
- **[D-021](DECISIONS/D-021-non-destructive-migration-framework-schema-only.md)** — Non-destructive migration framework — schema only ever grows
- **[D-020](DECISIONS/D-020-cross-project-ticket-backlog-distinct-from.md)** — Cross-project ticket backlog (`agent_tickets` + `agent_projects`), distinct from D-014 agent-run tables
- **[D-019](DECISIONS/D-019-emits-esm-does-auto-build-rebuild.md)** — `packages/shared` emits ESM; `dev` does not auto-build it (rebuild-after-edit is manual)
- **[D-018](DECISIONS/D-018-pomodoro-timer-logic-lives-tile-renders.md)** — Pomodoro timer logic lives in `packages/shared`; tile renders full widget on home page
- **[D-017](DECISIONS/D-017-sortie-follow-up-detection-state-based.md)** — Sortie follow-up detection is state-based (existing PR), not `.run.is_continuation`
- **[D-016](DECISIONS/D-016-sortie-hand-off-done-agent-turn.md)** — Sortie hand-off is done by the agent in-turn, not by `after_run`
- **[D-015](DECISIONS/D-015-widget-tile-flippable-card-component.md)** — Widget tile as a flippable card component (`lib/Widget.svelte`)
- **[D-014](DECISIONS/D-014-mission-control-ui-lives-personal-dashboard.md)** — Mission Control UI lives in Personal Dashboard; data owned by Symphony
- **[D-013](DECISIONS/D-013-symphony-standalone-project-claude-code-agent.md)** — Symphony as standalone project; Claude Code as the agent runner
- **[D-012](DECISIONS/D-012-multi-agent-coding-workflow-diy-symphony.md)** — Multi-agent coding workflow (DIY Symphony) — full architecture deferred
- **[D-011](DECISIONS/D-011-n8n-deferred-workflow-orchestrator.md)** — n8n deferred as workflow orchestrator
- **[D-010](DECISIONS/D-010-postgresql-deferred-sqlite-flagged-upgrade-agent.md)** — PostgreSQL deferred; SQLite flagged for upgrade on agent dashboard
- **[D-009](DECISIONS/D-009-all-widgets-share-one-sqlite-database.md)** — All widgets share one SQLite database, namespaced by table prefix
- **[D-008](DECISIONS/D-008-build-dashboard-shell-now-later.md)** — Build dashboard shell now, not later
- **[D-007](DECISIONS/D-007-show-raw-vs-matched-metadata-side.md)** — Show raw vs matched metadata side-by-side in the review UI
- **[D-006](DECISIONS/D-006-fuzzy-metadata-matcher-duration-gate-score.md)** — Fuzzy metadata matcher with duration as a gate, not a score component
- **[D-005](DECISIONS/D-005-track-status-small-enum-separate-booleans.md)** — Track status as a small enum, not separate booleans
- **[D-004](DECISIONS/D-004-defer-chromaprint-acoustid-fingerprinting-todo.md)** — Defer Chromaprint/AcoustID fingerprinting to TODO
- **[D-003](DECISIONS/D-003-scan-nas-mirror-dj-library-pc.md)** — Scan the NAS mirror of the DJ library, not the PC directly
- **[D-002](DECISIONS/D-002-local-db-queue-instead-pushing-everything.md)** — Local DB queue instead of pushing everything to Lidarr automatically
- **[D-001](DECISIONS/D-001-node-typescript-go.md)** — Node + TypeScript, not Go
