# Decision Log

Captures the _why_ behind key choices made during planning. Useful when revisiting a decision later — if a choice no longer fits, the original reasoning makes it easier to see what changed and whether to revisit.

Newest decisions at the top.

---

## D-058: One `queue` lane (assignee decides dispatch); `ready` (computed formatting) is the single dispatch gate with an explicit bypass; Epics are barred from the queue and get a `Populate` refine mode (PD-390, PD-377, PD-382)

**Decision:** Collapse the two queue lanes into one and make *who does the work* an independent axis from *the work is ready*. From the 2026-07-17 grill, which reconciled three bugs (PD-390 the lane asymmetry, PD-377 an Epic dead-ending in `steve_queue`, PD-382 Refine unable to flesh out an Epic):

- **One `queue` lane.** `robot_queue` + `steve_queue` collapse into a single `queue` status (supersedes D-055's two-lane split). **Assignee** (`robot` | `steve` | `null`) becomes an **independent axis** — it is *no longer forced by the lane* (reverses D-055) and is settable at any stage. Dispatch is `status='queue' AND assignee='robot' AND (ready OR ready_bypassed) AND unblocked` — "assigned to robot + queued + Ready = fair game for the loop." A `steve`-assigned queued ticket is just the personal to-do lane; `null` + queued is queued-but-unassigned (never robot-dispatched).
- **`ready` is the one gate — a computed formatting property, not a human-blessing flag.** The mechanical `isSortieReady` 4-section check (`## Context`/`## Task`/`## Done When`/`## Out of scope`) is **renamed `ready`, recomputed on every body write, and persisted** (D-057 had already demoted it to a soft hint). So `ready` always reflects the *current* body — editing a Ready ticket keeps it Ready as long as the formatting survives, and drops it the instant a section is lost. Approving a Refine no longer *sets* `ready`; it commits a well-formatted body and the recompute makes it Ready as a consequence — a hand-formatted ticket is equally Ready ("Ready" is about body shape, not about a session running). The loop reads the persisted flag (cheap, can't drift). `ready` is a **hard gate for the robot loop** and a **soft gate for the human**: queueing a not-Ready robot ticket pops a **confirm modal** ("not Ready — output may be suboptimal"), and confirming sets a **separate persisted `ready_bypassed` flag** (never fakes `ready`, so the board shows an honest "⚠ bypassed" badge). The loop gate is `ready || ready_bypassed`; `ready_bypassed` goes moot once the body is fixed. Cancelling the modal aborts the queue move.
- **An Epic is barred from the queue entirely.** The old guard ("Epic can't enter `robot_queue`") — whose narrowness *was* PD-377 (the edit path slipped an Epic into `steve_queue`) — becomes "an Epic can never enter `queue`," symmetric across drag and edit (both flow through `updateTicket`), empty or not, regardless of assignee. Assignee on an Epic is a **signal only** (D-054's "the whole Epic is robot-doable") and never dispatches, because the Epic can't be queued. Only member Tickets are ever dispatched.
- **Refine gets an Epic-specific `Populate` mode.** Distinct from `split`-decompose: **`Populate`** creates member Tickets linked by **`epic_id`** (membership) and **leaves the Epic open**; `split` creates children linked by `split` and **closes the parent** (D-036). This reverses D-054's "decompose is disabled on an Epic." Populated members inherit the Epic's `project_id` and route per D-057's Decompose-A (a proposed `queue` child parks in `prioritized`). `approveRefine`'s decompose branch, when the parent `is_epic`, **executes as Populate instead of throwing `cannot decompose an Epic`** — which also fixes PD-382 by reinterpreting its existing split-shaped proposal (no re-run).
- **Board: one Queue column.** The two adjacent queue columns become one; cards are **intermixed and ordered by `sortOrder`, distinguished by an assignee badge** (assignee is now a card attribute, not a lane). A **table-wide assignee filter** (reusing the `task-monitor:hidden-lanes` localStorage pattern) recovers the at-a-glance separation across all lanes. The two-band Epic layout (D-054) survives with its "In Progress" spanning cell collapsing to the single Queue column.
- **Symmetry + blocker gate.** Drag and edit enforce the identical queue-entry gate by construction (one `updateTicket` chokepoint). D-051's blocker gate retargets from `robot_queue` to `queue` unchanged.

**Why:** The two-queue model conflated two orthogonal things — *who does the work* (assignee) and *which lane* (status) — by making the lane force the assignee. That conflation spawned a whole bug class: two entry paths that could disagree (PD-390), a guard that only covered one of the two queues (PD-377), and a mental model where an Epic's assignee looked like it should dispatch. Separating the axes makes the model honest, makes drag/edit symmetric because there's only one gate, and reduces the loop's dispatch check to a flag read instead of a body parse. Folding `isSortieReady` into `refined` removes a second, near-duplicate "is this ready" concept; the explicit bypass keeps the human in control without letting an unshaped spec reach the autonomous loop silently.

**Trade-off:** A broad, type-level change (`TicketStatus` enum, every guard, `deriveEpicLane`, board rendering, refine routing, `select.ts` predicate) plus a one-time data migration — landing on a **live, armed loop** (C6 already cut over), so the enum change + backfill + predicate must ship in **one atomic release**, not a partial deploy where the server writes `queue` while the loop still greps `robot_queue`. Reversing D-054's "decompose disabled on an Epic" adds a second child-creation verb (`Populate` vs `split`) — accepted, because the alternative (overloading "decompose") re-muddies the split-vs-membership line D-054 fought to keep clean. Intermixing assignees in one column loses the hardcoded two-list view — bought back by the table-wide filter.

**Implications:** **Amends D-055** (two queues → one; lane-forces-assignee reversed; dispatch predicate rewritten), **amends D-054** (decompose-on-Epic reversed into `Populate`; band spanning cell collapses; empty-Epic hand-set excludes `queue`), **amends D-057** (`isSortieReady` renamed `ready`, made a computed-on-write persisted gate; `ready_bypassed` added). `isSortieReady` → `ready` (the check lives; only the name + recompute-on-write changed). Sliced into the **PD-341 robot-loop epic** as new members: (1) schema + shared `TicketStatus`/assignee decoupling + idempotent data backfill (incl. `ready = isReady(body)` across all rows); (2) server guards (epic-guard→`queue`, blocker-gate→`queue`, drop lane-forces-assignee, `ready` recomputed on body write + `ready_bypassed`); (3) `select.ts` dispatch predicate; (4) Refine `Populate` mode + PD-382 reinterpret; (5) board (one column, badges, table-wide assignee filter, confirm modal + bypass badge). Slices 1–3 deploy atomically. PROJECT.md §9 glossary updated inline (single **Queue**, independent **Assignee**, **Ready**/`ready`, **ready_bypassed**, **isSortieReady** marked renamed).

---

## D-059: Epic area drag-to-resize uses a CSS custom property driven by a pointer-capture handle; height persisted to `localStorage` (#249)

> _Renumbered D-058 → D-059 (2026-07-17): this number collided with the queue-model D-058 (#259, referenced across the code + PRs). This older UI decision took the new number; the queue-model kept D-058._

**Decision:** The horizontal divider between the Epic band (row 2) and the Ticket band on the board (now row 4) is made resizable by inserting an 8px grid row (row 3) containing a full-width `<div class="epic-resize-handle">` element. Dragging it updates a `--epic-area-height` CSS custom property on `.board`; the epic cells' `max-height` is driven by that variable. The chosen pixel height is saved to `localStorage` under `task-monitor:epic-area-height`.

**Alternatives considered:** (a) overlay an absolutely-positioned handle on the epic cell's bottom border — avoids touching the grid but requires knowing the epic band's rendered position at runtime; (b) derive height from mouse position relative to the board element — equivalent complexity, less composable. The explicit grid row is the most straightforward because the handle becomes a real grid participant instead of a positioned overlay.

**Why pointer capture:** `HTMLElement.setPointerCapture()` redirects all pointer events to the handle element for the lifetime of a drag, so `onpointermove`/`onpointerup` handlers on the handle itself receive events even when the pointer moves above/below it quickly. No global `window` listeners needed.

**Clamping:** Heights are clamped to [36px, 600px] via `clampEpicHeight()` in `board-logic.ts` (tested in `board-logic.spec.ts`). 36px is the epic cell's `min-height`; 600px is a generous ceiling.

---

## D-057: Refine approval never dispatches — split "Approve" from "Approve & queue"; `isSortieReady` is a soft hint (PD-377)

**Decision:** Approving a Refine commit proposal no longer moves anything into `robot_queue`. Entering the Robot's Queue becomes a separate, explicit act. Triggered by a bug: approving a Refine session on an **Epic** 500'd (`EPIC_NOT_QUEUEABLE` escaping `approveRefine`'s no-throw contract into an un-caught route), which exposed that approval was silently auto-dispatching whatever lane the agent proposed. From the 2026-07-16 grill:

- **Approval ≠ dispatch (the policy).** A plain **Approve** applies the refined spec (body/priority/assignee) and marks the ticket `refined`, but never enters `robot_queue` — an agent-proposed `robot_queue` is parked in `prioritized`. This mirrors the principle already baked into the board: *dragging into the Robot's Queue is the dispatch trigger* ([[D-055]]). Dispatch is now always a deliberate act, so it can never be a surprise side-effect of approving a spec.
- **Two buttons (the control).** `refine_in_place` shows **Approve** and **Approve & queue**; the latter (`{ queue: true }` on the approve endpoint) does the approve *and* the `robot_queue` transition in one step. "Approve & queue" is offered **only for a non-Epic `refine_in_place`** — an Epic can never be queued (D-054), and a decompose routes per-child, not as one unit. Chosen over a confirm-prompt (strictly worse — an extra click for the same choice) and over a post-hoc toast (narrates the mistake instead of preventing it).
- **Decompose = version A.** A decompose creates its children in **non-queue lanes** — a proposed `robot_queue` child is parked in `prioritized` — closes the parent (D-036), and links via `split`. The shaped body is preserved, so a parked child is one drag from dispatch. You review, then drag the ready ones in; you rarely want to fire an entire decompose at once.
- **`isSortieReady` is a soft shape hint, not a gate.** It was only ever enforced in the approval path (the drag path — `updateTicket` — never checked it, so the "shape gate at queue entry" was already only half-real). Both approval enforcement points are removed by the two decisions above, so the gate is deliberately made soft everywhere a **human** queues: a "needs shaping" hint in the Refine UI (and the existing board-drag toast), never a block. The genuine hard queue-entry invariants stay hard in `updateTicket`: the **Epic guard** and the **blocker gate** (D-048).

**Why:** The 500 was a missing pre-check, but the fix surfaced the deeper smell — approval conflated "this spec is good" with "dispatch it now," so an agent's proposed lane silently armed an autonomous run. Separating the two makes dispatch intentional and makes the Epic constraint a visible affordance (no "& queue" button) instead of an error. Keeping `isSortieReady` soft matches the existing drag path and the human-in-the-loop trust model (an interactive actor owns the dispatch call); the body shape is a quality nudge, not a wall.

**Trade-off:** A refined, ready-to-run single ticket now takes one extra click ("Approve & queue") or a drag, instead of dispatching on plain Approve — accepted, because silent dispatch was the hazard. `approveRefine` gains a `queue` param and a `queued` result flag; the route keeps a defensive `EpicGuardError` catch (→ 409) as a backstop even though the pre-check makes it unreachable on the known path. The `child_not_sortie_ready` reason / `NOT_SORTIE_READY` code are retired.

**Implications:** `approveRefine(db, id, { queue })` (store.ts) — `refine_in_place` parks proposed `robot_queue` in `prioritized` unless `queue:true`; decompose downgrades robot-bound children to `prioritized`; a clean `epic_not_queueable` reason replaces the escaping throw. The `refine-approve` route threads `queue`, maps `epic_not_queueable`→409, and catches `EpicGuardError` defensively. `TicketThread.svelte` renders the two buttons (+ soft "needs shaping" hint) and is passed `isEpic`. **Open follow-up (not in this change):** the Refine agent still *proposes* `robot_queue` routing; under this model that proposal is mostly moot (approval parks it) and nonsensical for an Epic — worth teaching the propose-tool prompt to stop routing to queue lanes.
---

## D-056: Pomodoro interval settings as a shared draggable bar-graph component (`IntervalBars`) rather than duplicated `<input type="number">` rows (#235)

**Decision:** Extract the five Pomodoro setting inputs (Work, Short Break, Long Break, Rounds → Long Break, Total Rounds) into a single shared component `apps/web/src/lib/pomodoro/IntervalBars.svelte` using vertical draggable bar graphs. Both `PomodoroTimer.svelte` and `FloatingPomodoro.svelte` consume it via `bind:` props + per-field `onChange` callbacks. The bars use independent Y-axes (each bar scaled to its own min/max), snap duration bars to 5-minute steps and count bars to 1, and use a two-layer `clip-path` technique for the value label to remain legible at any fill level.

**Alternatives considered:**
- Keep the number spinners and just extract the duplicate row markup into a shared component — would remove duplication but the ticket explicitly calls for a bar-graph control.
- A generic reusable slider — explicitly out of scope; kept Pomodoro-specific in `lib/pomodoro/`.

**Why clip-path for label legibility:** Two identical `<span>` elements are rendered; the first uses `--text` color (legible on the unfilled surface), the second is clipped via `clip-path: inset(calc(100% - var(--fill)) 0 0 0)` to the filled region and uses `--on-accent` (legible on the accent fill). This produces a smooth split-text effect at any fill level without JS-based threshold checks.

---

## D-055: Retire the third-party Sortie runtime — absorb dispatch into `agent-worker` as the **Sentinel loop**; board DB becomes the agent-state machine (PD-323/PD-231/#220)

**Decision:** Replace the third-party `ghcr.io/sortie-ai/sortie` dispatcher with a new `sentinel` job in `apps/agent-worker` (which we already own — Agent SDK, DB-as-queue, egress-hardened, and already hosting `refine`/`audit`). Resolved in the 2026-07-08 grill:

- **Build, not buy.** Upstream Sortie has had no release in ~3 weeks; we've already home-rolled hand-off (D-046) + four reaction bridges + the watchdog, and the remaining Sortie surface (label-poll loop, concurrency cap, retry budget, workspace hooks) is thin and re-implementable. `agent-worker` already carries ~80% of the infra (proxy, grounding checkout, DB, heartbeat, job model).
- **Sequencing: before the Mac Mini migration** (PD-188, currently backlog). Absorb on the NAS → validate in the `max_concurrent=1` pilot → decommission Sortie → *then* migrate one consolidated worker. Don't migrate infra you're about to delete; also isolates risk (never change runtime and host at once).
- **Dispatch keys off `robot_queue` in the board DB**, not GitHub labels. The board is already the durable source of truth (D-039); DB dispatch removes the display-id-vs-issue# confusion and the label-write auth on the critical path (the bot-PAT-scope 403 that froze #202 becomes impossible — auth only matters at push/PR time, where a failure is per-ticket, not a board-wide freeze). GitHub is demoted to **execution lease + review surface**.
- **The board DB becomes the agent-state machine** (supersedes [[D-020]]'s "labels are the state machine"). `github-sync` inverts from deriving state *from* labels to *pushing* `sentinel:*` labels *from* DB state, best-effort; a label-write failure is now cosmetic. The four `sortie-*.yml` bridges fold into the loop (watchdog → in-process stall detection; ask_human → resume on the Notification-Center reply already in `dashboard.db`; review-rework + conflict-rework → collapse into one PR-state poll). **Auto-merge (in `ci.yml`) stays** — it's a pure GitHub-side merge with no agent involvement.
- **Workspace = git worktree per ticket** off the maintained grounding checkout (the pattern we already use by hand), with the #220/[[D-046]] pristine-tree hygiene (`git reset --hard` + `git clean -fd`, PD-340) baked in — so the #220 dirty-tree freeze can't recur.
- **Three-tier fault-aware retry** (native, replacing Sortie's blind `max_sessions`): **transient** (turn died with no output, network/CI flake) → retry with backoff, per-ticket cap **3**; **deterministic** (repeated identical signature, path-guard rejection, setup fault) → **0 retries**, park + surface; **system-wide** (GitHub/Anthropic auth 401/403) → **pause the whole loop** + alert, zero per-ticket burn. Identical-signature auto-promotes transient→deterministic at **N=2** (would have stopped #220 at attempt 2, not 5). This natively delivers PD-323's auth-fault guardrail with no external log-watcher.
- **Native control surface.** A new `agent_runs` table + agent milestones on the existing ticket `events` timeline; ticket detail renders run history + latest failure reason; Site Status shows global dispatch state + fault banner. Remediation (**reset** / **unstick** / **pause-resume**) are plain board-API DB writes the loop honors on its next poll — **no container→host bridge, no sudo**, because the loop is our process reading the same DB.
- **uid privilege-split.** The loop process holds the only `dashboard.db` handle and is the **sole DB writer**; the coding session (a **Sentinel**) is spawned as a distinct lower-privilege uid whose filesystem view is its worktree only (`dashboard.db` mode-600, unreadable to it). This keeps one container (good for the migration) while **structurally enforcing D-039** — a Sentinel *can't* queue or self-complete because it can't touch the board DB.
- **Cutover:** strangler behind a `dispatch_enabled` flag → prove-on-one real ticket → one-time reconcile (label→state) + invert `github-sync` → drain the ≤1 in-flight Sortie job → flip → keep Sortie stopped-but-present for a rollback window → decommission (delete container/image/`WORKFLOW.md`/bridges/`.sortie.db`/`sortie-reset`/second squid).

**Naming (de-overloading "sortie", which meant the dependency, the loop, and the agent all at once):** the spawned ticket-completing coding agent is a **Sentinel**; the dispatch job in `agent-worker` is the **Sentinel loop** (job type `sentinel`); one agent attempt on a ticket is a **run** (`agent_runs`). The `sortie:*` GitHub label namespace is renamed **`sentinel:*`** at cutover. The old product name "Sortie" retires entirely.

**Why:** We were paying an ongoing tax to plug holes in a stale third-party runtime while it forced GitHub-as-queue and labels-as-state-machine — the root of a recurring class of freezes (#202 auth 403, #220 dirty-tree retry, #211/#212 cap-burn). Owning the loop makes observability, guardrails, and remediation *native* (same DB, same process) instead of bridged, and collapses the whole PD-323/PD-231 scaffolding — the container→host control bridge and the `.sortie.db` read bridge existed *only* because Sortie was a separate closed process in a separate container.

**Trade-off:** A meaningful one-time build (vs a few more bridges) and a new attack surface (a coding agent in the DB-writing process) — mitigated by the uid split. We lose Sortie's battle-tested loop and ship our own; mitigated by the strangler + prove-on-one + rollback window. Polling PR state (no webhooks) instead of Actions events — acceptable and unavoidable anyway (LAN-only dashboard can't receive webhooks).

**Implications:** Sliced into a parent tracking ticket + **C1** (Sentinel-loop skeleton: `sentinel` job, worktree lifecycle, coding session, D-046 hand-off, uid split, flag off, prove-on-one — the tracer bullet) → **C2** (fault guardrail, absorbs PD-323 core) / **C3** (observability, absorbs PD-231 debug + PD-255 + PD-323 surface) → **C4** (remediation controls, absorbs PD-231 button + PD-323 resume) / **C5** (fold the four bridges) → **C6** (cutover + `github-sync` inversion + decommission, Steve-supervised) → **C7** (codebase `sortie`→`sentinel` terminology + dead-config sweep). Wired with `blocks` relations (dogfooding [[D-051]]). PD-323/PD-231/PD-255 close as superseded; **PD-340/PR #223 stays** as the stopgap keeping current Sortie healthy until C6. Glossary terms (*Sentinel*, *Sentinel loop*, *run*, *fault tier*) added to PROJECT.md §8; the retiring *Sortie watchdog* etc. marked superseded.

**Amendment (2026-07-16, C5/PD-346 — the four `sortie-*.yml` bridges folded into the loop):** The four reaction workflows are deleted and re-implemented as native pre-dispatch reconciliation the loop runs each cycle before selection (all DB-native, no labels read or written). Sub-decisions worth recording:
- **ask_human resume is DB-native, not GitHub-mediated.** The old path (Notification-Center reply → GitHub issue comment + `<!-- sortie:human-reply -->` marker → `sortie-ask-human.yml` re-labels → `github-sync` derives `queued`) is replaced: the `/tickets/:id/reply` route now records a **`robot_human_reply`** event in `dashboard.db` (and best-effort mirrors to a linked issue only during the Sortie transition window). This **changes the `/reply` contract** — it no longer 409s on an unlinked ticket or 503s without a write token; it records the reply (201) regardless, since the loop, not GitHub, is the consumer. The resume sweep re-queues an `awaiting-human` ticket once a reply post-dates its question; because the coding uid is **DB-blind**, the loop injects the Q&A into the resume prompt (the agent can't read the DB itself).
- **review-rework + conflict-rework collapse into one PR-state poll.** For each `in-review` ticket the loop polls its PR via the GitHub **read** API (`gh pr view --json mergeable,reviewDecision,reviews,comments`) and re-activates on: a trusted **CHANGES_REQUESTED / bodied COMMENTED review**, a trusted **top-level PR comment** (Steve's usual channel — the second half of PD-256), or a **CONFLICTING** merge state. Trust model preserved from the bridges (OWNER, or COLLABORATOR + human-reply marker); a pure APPROVED review is never a trigger. Re-trigger loops are bounded by the **last hand-off timestamp** — only feedback newer than the newest `handed-off` run counts. Throttled to its own cadence (`ROBOT_PR_POLL_INTERVAL_MS`, default 3m) inside the one loop. Polling (not webhooks) is unavoidable anyway — a LAN-only dashboard can't receive them.
- **Stall detection is in-process orphan detection.** A run stuck `running` past `ROBOT_STALL_THRESHOLD_MS` (default 2h) whose ticket is still `working` is a process-restart orphan; the loop closes it through the **same C2 fault guardrail** (first stall → re-queue; repeated → park `stuck`). The old watchdog's **queued-staleness sweep and label-rescue job are dropped as obsolete** — "Sortie down / not dispatching" can't happen when the loop is the dispatcher, and there are no state labels to lose now the DB is the state machine.
- **Parks surface via the Notification Center.** The loop writes an `agent_needs_human` (stuck/faulted/stalled) or `agent_awaiting_human` (ask_human) notification directly, replacing the watchdog's @-mention/Discord ping and the label-derived `github-sync` notifications (C6 inverts that path).
- **Resume-aware prompt.** The coding prompt gained a **Step 0** that has the agent detect an existing PR on its branch and read the review feedback / resolve a conflict before re-implementing (rework needs no loop-side injection — the agent reads the PR itself), plus the ask_human answer block above.
- **Deletion timing:** the four YAMLs were removed in C5 (per the ticket) rather than deferred to C6 — safe because the Sortie container is stopped, so the bridges served nothing live. **`sortie-auto-merge.yml` stays** ([[D-052]]) — a pure GitHub-side merge with no agent involvement. Separately pinned on **PD-347 (C6)**: retire GitHub **issue-minting** entirely (the board Ticket is the spec, the PR is the lease/review surface), decommissioning the PD-164 issue-creation poller.

**Amendment (2026-07-16, C6/PD-347 — cutover: the board DB becomes authoritative):** The go-live behavioural flip. GitHub is demoted from state machine to a pure execution surface. Sub-decisions:
- **`github-sync` is retired, not inverted.** The original plan was to invert the sync (push `robot:*` labels *from* DB state). We chose to **stop writing labels entirely** instead ([[D-055]] cutover call): post-cutover the board DB is the sole source of truth, and — because issue-minting is also retired — new tickets have no issue to label anyway. Both cron directions (`runGithubSync` label→board read, `runQueuedSync` queued→issue write) and the on-demand `/sync` route are unregistered / made no-ops. This kills the **coupling bug** the C1 field note caught: `github-sync` was overwriting the loop's `in-review` hand-off back to `queued` from a stale `sortie:queued` label, re-dispatching the same ticket. The now-dead `deriveState`/`runGithubSync`/`runQueuedSync` code + `sortie:*` strings are left in place for **C7**'s dead-config sweep, so this PR is a pure behavioural flip.
- **Completion becomes DB-native — the PR is the completion signal.** Retiring `github-sync` removed the *only* path that marked a ticket `completed` (it read the `Closes #N` issue going closed). The loop's PR-state poll (C5) now owns terminal transitions too: a **MERGED** PR → `completed`/`done`; a PR **CLOSED unmerged** → parked `needs-human` (a human abandoned it — never silently complete or re-dispatch). `gh pr view` gains `state` in its `--json`. This is what lets the PR — not a GitHub issue — be the execution lease end-to-end.
- **Issue-minting retired (PD-164).** No GitHub issues are created. The whole path tolerates `github_issue_number = null` (C5 verified: branch → `robot/t<id>`, `/reply` DB-native, archive-close guarded); C6 also fixes the ticket-detail **reply box**, which was gated on a linked issue — now gated only on the parked state, so a human can answer a DB-native ask_human on an issueless ticket.
- **Dispatch scope + killswitch (`ROBOT_ALLOWLIST`).** The prove-on-one gate (empty ⇒ nothing) flips to go-live semantics: **unset/empty ⇒ `all`** (dispatch every eligible `robot_queue` ticket, still bounded by `ROBOT_DISPATCH_ENABLED` + `ROBOT_CONCURRENCY`); the literal **`NONE` ⇒ block everything** (a per-allowlist killswitch that halts new work without touching the master switch); an **id list** still restricts (prove-on-N). A non-empty garbage value fails safe to `none`.
- **Decommission is deferred + supervised.** Deleting the Sortie container/image, `.sortie.db`, `sortie-reset`, `WORKFLOW.md`, and the second squid sidecar happens **after N clean pilot completions**, not in this PR — a rollback window with Sortie stopped-but-present. Ordering that matters at cutover: deploy this (label sync dead) **before** arming the loop, or the old sync re-dispatches.

---

## D-054: Epics are a first-class umbrella primitive (`is_epic` + `epic_id`), distinct from `split`; status is derived and rendered in a non-draggable board band (PD-318)

**Decision:** Add an **Epic** to the board — a Ticket that groups other Tickets. Choices from the 2026-07-08 grill:

- **Its own primitive, not a relation or a tag.** An Epic is `agent_tickets.is_epic = 1`; membership is a single-parent **`epic_id`** FK on the member Ticket (at most one Epic per Ticket). The `agent_ticket_relations` table (blocks/relates/duplicates/split) is left untouched — containment and peer-dependency are different shapes, and conflating them is what muddied `split`-vs-epic in the first place.
- **Terminology.** *Epic* + *Ticket* (member). **"Issue" stays reserved for the GitHub execution lease** — an Epic contains Tickets, never "issues". **"parent/child" stays reserved for `split` decompose lineage** — the Epic↔member relationship is "contains / belongs to".
- **Umbrella, never dispatched.** An Epic cannot enter `robot_queue` (structurally impossible — see the band model); `isSortieReady` does not apply; assignment does not cascade. Decompose (`split`) is disabled on an Epic (it would close the umbrella, [[D-036]]). No nesting (an Epic can't belong to an Epic). Members share the Epic's `project_id`.
- **Status is derived, not dragged.** A non-empty Epic's lane is computed from its members: any member in Steve's/Robot's Queue → **In Progress**; all `completed` (or completed+closed) → **Completed**; all `closed` → **Closed**; else the least-advanced pending lane (Backlog before Prioritized). An **empty** Epic defaults to Backlog and may be hand-set until it gains a member (then derivation takes over).
- **Two-band board.** A horizontal divider splits every lane: a top **Epic band** (stripe-tinted, non-draggable, derived placement, with an **In Progress** cell spanning the two queue columns) and the normal **Ticket band** below. Only the bottom band is the real Robot's Queue, so an Epic can never be picked up by Sortie. Epic `+` buttons appear in Backlog/Prioritized only; the board filter toggles band visibility (Epics / Tickets / both).
- **Assignee = manual signal.** `robot` = "the whole Epic is robot-doable", `steve` = "≥1 member needs me". A **"Dispatch ready members"** action (queue eligible members: robot-assigned + `isSortieReady` + unblocked + Backlog/Prioritized, with a report) is deferred to **v2** (P4) — an explicit button, never a silent side-effect of setting the assignee.
- **Archive is a choice.** Archiving an Epic prompts: archive the Epic only (unlink its members) or archive the Epic + all N members. Never a silent cascade.

**Why:** Epics were being expressed only in prose ("Epic: PD-281", title prefixes). `split` is the closest existing shape but means "a decompose happened and the parent was closed" — the opposite of a live umbrella that stays open and rolls up. A dedicated primitive keeps `split` honest and gives real roll-up/containment. Derived status + the band model resolve the core tension (an Epic's members are scattered across lanes, so an Epic has no single hand-dragged lane) while keeping everything on one board.

**Trade-off:** A second linking mechanism (FK) alongside relations — accepted, because containment ≠ peer-dependency. The two-band layout with a spanning In-Progress cell is the fiddliest part to build. Single-parent membership forbids a Ticket living under two Epics (chosen for coherent roll-up).

**Implications:** Sliced from **PD-318** into three v1 tickets — backend (schema + migration + membership API + derived status/roll-up + split-inheritance + archive-choice + guards), board rendering (two-band layout + derived placement + filter), membership UX (modal checkbox + epic dropdown + kebab "Add to Epic" + Epic detail page) — plus a **v2** ticket (P4) for the "Dispatch ready members" button + batch member-create. Glossary terms (*Epic*, *Epic member*, *Derived Epic status*, *Epic roll-up*) added to PROJECT.md §9. PD-318 decomposed into the slices and closed.

**Amendment (2026-07-09):** Epics are drag-**reorderable within their derived lane**. This narrows the original "non-draggable" wording: an Epic's *lane placement stays derived* (it can never be dragged across lanes or into a queue — the whole point of the band model), but within the cell it lands in, the card can be dragged to set its `sortOrder` relative to sibling epics (same fractional-order pattern as tickets, [[D-026]], minus priority banding). Also shipped alongside: a per-lane **max-height** on the Epic band (so a crowded band scrolls instead of shoving the ticket band down) and an **"Epics & Lone Tickets"** type-filter option (epics + only tickets with no `epic_id`). All frontend-only, landed in the PD-338 recovery PR (#228 — PD-338 had merged into the PD-337 branch instead of main; see MEMORY 2026-07-09).

---

## D-053: Widget "Arrange" mode edits the existing auto-flow grid (reorder + resize) with per-page `localStorage` overrides — not free 2D placement, not DB persistence (PD-331)

**Decision:** The widget **Arrange** feature lets the user rearrange and resize widgets on any widget-bearing top-level page (Home + the six content pages; Task Monitor is excluded — it's a Kanban, not a widget grid). It is deliberately scoped to editing the **existing auto-flow CSS grid**, not introducing a new layout engine:

- **Two editable properties per widget, per page:** *order* (a fractional sort key, reusing the board's `sortOrder` pattern from D-026) and *size* (an integer `{cols, rows}` span, reusing the `--col-span`/`--row-span` mechanism embedded widgets already carry from D-050). No free x/y placement, no gaps, no absolute positioning — cards still reflow to fill.
- **Persistence is `localStorage`, keyed per page** (`dashboard:layout:<pageId>` → `[{id, order, cols, rows}]`). The registry (`widgets.ts`) values are the default when no override exists; on load the override is *merged* with the registry so a widget added to the registry later (absent from a saved layout) falls back to its default position (appended after saved cards in registry order), and a stale/removed id is ignored.
- **Interactions:** reorder via a Svelte DnD library (`svelte-dnd-action`, pending a Svelte-5-runes compat check), resize via a hand-rolled corner handle snapping to whole spans (min 1×1, cols clamped to the visible column count, rows capped ~6). Changes **live-apply** and persist on every drag/resize; a **"Reset to default"** clears the page key. No Save/Cancel snapshot.
- **The Arrange button lives in the app-wide top-nav** (top-right, near the theme toggle), shown *only* on arrangeable pages (≥1 widget) and *only* at viewport ≥768px.
- **Mobile (≤768px) is a read-only reflow:** no Arrange button; the grid stacks to a single column in saved order with spans collapsed to full width. Layout is authored on a large screen; the phone is a responsive view of it.

**Why:** PROJECT.md's vision line ("movable and resizable … like a datadog dashboard") reads as free 2D placement, but that means an x/y/w/h coordinate model, collision/compaction rules, and a heavy grid library — a large lift whose payoff is thin for a single-user LAN tool. Reorder+resize on the grid that already exists delivers the felt outcome (I choose what's where and how big) while reusing three mechanisms already in the codebase (auto-flow grid, `span`, fractional sort). `localStorage` matches the established client-persistence precedent (`theme`, `task-monitor:hidden-lanes`), needs no backend (the shell owns no DB tables today — widgets do), and its per-device nature is arguably correct: a layout tuned for a wide monitor need not follow you to a phone, which reflows to one column regardless.

**Trade-off:** (1) Chose reorder+resize over the datadog-style free placement the vision line implies — accepted because free placement is a different architecture for marginal benefit here; revisiting means a real rebuild, hence this record. (2) Chose `localStorage` over a DB table even though every *widget* owns DB tables — accepted; the cost is no cross-device sync and loss on cache-clear, both tolerable for a personal tool, and a DB table is a clean later upgrade. (3) A CSS-grid span on a collapsed 1-column mobile grid would overflow its track, so spans *must* collapse on mobile — which is why Arrange is desktop/tablet-only rather than a half-working touch experience.

**Implications:** PD-331 (P1) is the implementation. **PD-334** (P3) is V2 — add/remove widgets per page + a widget-library concept, which turns per-page *membership* into editable state on top of this layout model. **PD-333** (P4, investigation) asks whether the Task Monitor board's native-HTML5 DnD (D-026) should migrate onto the same library this feature adopts. New glossary term *Arrange mode* added to PROJECT.md §9 (new "Dashboard shell" subsection). Builds on D-050 (embed span) and the D-026 fractional-sort pattern.

---

## D-056: Arrange mode drag-to-reorder uses native HTML5 DnD (commit-on-drop) rather than `svelte-dnd-action` (PD-331)

**Decision:** D-053 specifies `svelte-dnd-action` for reorder, but adding it would touch `package.json` (dependencies), which is a guarded zone for autonomous agents (CLAUDE.md). Implemented reorder via the browser's native HTML5 drag-and-drop API instead: each widget is `draggable="true"` in arrange mode; `ondragover` highlights the drop target; `ondrop` splices the layouts array and persists to `localStorage`. This is commit-on-drop (the layout updates when the user releases the mouse over a target) rather than live-reorder during drag.

**Alternatives:** `svelte-dnd-action` — better animation and live-reorder during drag, but requires adding a dependency. PD-333 (if/when the DnD libraries are evaluated) could upgrade this surface to `svelte-dnd-action` once the Svelte 5 compat question is answered and the package is added by a human.

---

## D-052: Auto-merge bridge keys off `mergeStateStatus == CLEAN`, not specific check names (PD-211)

**Decision:** `.github/workflows/sortie-auto-merge.yml` squash-merges a PR when it detects a standing authorized `APPROVED` review AND `mergeStateStatus == CLEAN` (GitHub's composite signal: no conflicts + all required CI checks green + review requirements satisfied). Deliberately does NOT enumerate specific check names like `verify`.

**Reasoning:** keying off `mergeStateStatus` means any future required check added to branch protection (e.g., the D-047 path-guard) is automatically honored without editing the workflow. Hard-coding check names creates a maintenance hazard — the auto-merge would bypass new protections silently. `CLEAN` is the single authoritative signal that GitHub's own branch-protection layer is satisfied.

**Alternatives considered:** (a) check `reviewDecision == APPROVED` — redundant since `CLEAN` implies reviews are satisfied per branch-protection rules; (b) enumerate required checks by name — fragile, couples the merge bridge to CI config.

**Amendment (2026-07-08, PD-211):** the original workflow used `check_suite`/`status` triggers to catch the "approved before CI went green" case. Those are **silently dead**: GitHub suppresses `check_suite`/`status` events that originate from `GITHUB_TOKEN` (which runs the `ci` workflow) to prevent recursive runs — so a review that landed before CI finished saw `mergeStateStatus != CLEAN`, skipped, and the promised re-fire never came, leaving the PR approved-and-CLEAN but unmerged forever. Replaced both with a single `workflow_run` trigger on the `ci` workflow completing — `workflow_run` is GitHub's sanctioned exception and *does* fire for `GITHUB_TOKEN`-run workflows. Also fixed a latent bug in the (never-executed) SHA→PR resolution: `gh`'s `--jq` flag doesn't accept `--arg`, so it now pipes to the runner's real `jq`. The `mergeStateStatus == CLEAN` decision above is unchanged; only the trigger wiring was wrong.

---

## D-051: A `blocks` ticket relation is a **hard `robot_queue`-entry gate** (a second queue-entry precondition beside `isSortieReady`); relations carry an `origin` (agent|human); PD-156 sliced backend→frontend (PD-156)

**Decision:** Ticket relations become first-class *and behavioral*, not cosmetic. Key choices from the 2026-07-07 grill:

- **`blocks` hard-gates queue entry.** A ticket cannot **enter `robot_queue`** while it has any unresolved blocker — a second entry precondition alongside [[D-046]]-era `isSortieReady` (the shape gate). "Blocked" is not merely displayed; it *refuses dispatch*. Chosen over an informational-only badge because the only actor that ever queues is a **human** (a Sortie worker creates into `backlog` only, [[D-039]]), so the gate protects Steve from dispatching work that can't proceed. Enforced in the `updateTicket` status transition — the chokepoint that both board drag-drop and Refine-in-place routing pass through (decompose children / direct creates are brand-new so can't yet carry blockers).
- **Direction convention.** A `blocks` row stores `from = blocker`, `to = blocked`. "A blocked by B" = row `(from=B, to=A)`. A ticket's gate reads its **incoming** `blocks` rows; its "blocking N" badge reads **outgoing**.
- **Resolved = done or gone.** A blocker stops gating when it reaches `completed` / `closed` / `archived`. The four active lanes (`backlog` / `prioritized` / `robot_queue` / `steve_queue`) still block.
- **Full cycle detection.** Adding a `blocks` edge that would close a cycle (DFS over the blocks graph, any depth) is **refused** at add-time (the error carries the path); self-relations refused for all types. A hard gate makes a cycle a *silent permanent deadlock*, so prevention is mandatory. Cycle detection is `blocks`-only — cycles in `relates`/`duplicates`/`split` are harmless.
- **Entry-only, with a confirm for the reverse.** The gate fires on *entry* (like `isSortieReady`); it does **not** retroactively evict an already-queued ticket. But **blocking a ticket that is already in `robot_queue`** pops a confirm modal (PD-322) and is allowed on confirm. So: *queue a blocked ticket* = hard-refused; *block a queued ticket* = allowed-with-confirmation. No auto-eviction (which lane would it land in? mid-dispatch yank).
- **Relation `origin` (agent|human).** New column `agent_ticket_relations.origin TEXT NOT NULL DEFAULT 'agent'`. The default back-fills every existing row (all `split`, all griller-authored) correctly with **zero data migration**; the human UI writes `'human'`. One mechanism labels provenance across **all four** types — so an Audit-suggested `relates`/`duplicates` ([[D-045]]) reads as agent-authored, and a hand-drawn link reads as human. Display: agent `split` → "auto-split 🤖", human → "split".
- **All four types hand-manageable.** `blocks` / `relates` / `duplicates` / `split` all get create+remove UI. `split` becomes hand-creatable too (previously griller-only) — `origin` is what preserves the distinction the glossary cares about, rather than a separate `auto-split` type (which would fragment `getLineage`'s `type='split'` query and not help provenance on the other three types).

**Why:** Relations existed as a schema + type-agnostic store primitives (PR #199) but no behavior and no write UI. The grill's pivotal move was choosing **behavioral over cosmetic** for `blocks`: once it gates dispatch, the rest (direction, resolved-def, cycle safety, retroactive rule) follows to keep the gate sound. `origin` fell out of "can we tell a human split from an auto-split?" and generalized because the Audit is itself an agent author of relations.

**Trade-off:** A hard gate can deadlock via cycles — bought off with mandatory full cycle detection. Entry-only leaves a blocked ticket sitting queued if it's blocked *after* queueing — bought off with the confirm modal (conscious choice) rather than complex auto-eviction. `split` becoming hand-creatable loosens its "a decompose happened" implication — bought back by `origin` carrying the provenance instead of the type.

**Implications:** Sliced from **PD-156** into two vertical slices (both P1): a **backend** slice (**PD-321**, this commit) — `origin` column + shared `RelationOrigin` + `ResolvedRelation.origin`; `addRelation` origin threading + self/`blocks`-cycle validation; the gate in `updateTicket`; relation write endpoints. The read route `GET /tickets/:id/relations` is **widened** from the PD-269 split-only `TicketLineage` to the full `ResolvedRelation[]` (both directions, with origin) — the detail page derives its split subset client-side; this temporarily changes the shape the deployed PD-269 detail page consumes until PD-322 lands (acceptable — LAN-only personal site). New `POST /tickets/:id/relations` (`origin='human'`; 400 self, 409 cycle) + `DELETE /tickets/:id/relations/:relationId`; the `robot_queue` gate surfaces as **409 `BLOCKED_BY_UNRESOLVED`** on both the PATCH and refine-approve routes. The **frontend** slice (**PD-322**, depends on PD-321) — ⋮ kebab "Mark as" submenu; ticket-picker modal reusing `ticketMatchesQuery` + `Modal.svelte`; card badges; detail-page authoritative list + the split-lineage view rebuilt over the widened endpoint; drag-drop rejection UX; the block-a-queued-ticket confirm modal. Feeds [[D-045]] — the Audit's LINK/UNLINK now write with `origin='agent'`. Glossary (*ticket relation*, *`blocks` relation*, *blocker gate*, *relation origin*, *resolved blocker*) added to PROJECT.md §8.

---

## D-050: Embedded live widgets use a registry-provided component + span; generic card is shared chrome (PD-207)

**Decision:** Widgets that want to render live content on the home grid and page stubs register an `embed` object in `widgets.ts` containing a Svelte component and a `{ cols, rows }` grid span. `Widget.svelte` is the shared card chrome: when `embed` is absent it renders the existing link-stub + "Rear panel" placeholder; when present, it renders the component (variant="widget") and uses its own ↺ button to toggle `view` between `'generator'` and `'manage'`, which the component renders accordingly. The grid adds `grid-auto-rows: 140px` so integer-multiple spans give predictable card heights.

**Why:** Widgets are conceptually mini-apps that should be usable directly on the dashboard grid, not just link tiles. The pattern is established with ASG as the first consumer; other widgets can opt in by adding an `embed` entry without touching Widget.svelte or the grids.

**Trade-off:** The embed component API (`variant` / `view` props) is enforced by convention, not TypeScript generics — the registry types `component` loosely to avoid threading per-widget prop types through the generic registry. A future strict-mode approach could use a discriminated union per widget, but at O(10) widgets this adds complexity for no practical benefit.

---

## D-048: Acute Strategies Generator stores tags as a JSON array in a SQLite TEXT column (PD-202)

**Decision:** Idea tags are stored as a JSON array in a `TEXT` column (`tags TEXT NOT NULL DEFAULT '[]'`), not in a separate join table.

**Why:** The ideas list is small (O(100) entries), tags are only used for client-side filtering, and a join table adds schema complexity with no benefit at this scale. SQLite's built-in JSON support lets us parse/serialize in the store layer without any extra SQL joins.

**Trade-off:** Tag-based aggregation queries (e.g. "count ideas per tag") would require JSON parsing in SQL or in application code. Acceptable for a personal dashboard; revisit if a tag management UI becomes needed.

---

## D-049: Acute Strategies Generator uses client-side filtering and randomisation (PD-202)

**Decision:** All ideas are loaded once via `GET /api/widgets/acute-strategies-generator/ideas`. Filtering by type/tag and random selection are done in the browser.

**Why:** The ideas list is small enough that loading all of them upfront is negligible. Client-side randomisation avoids a network round-trip on every Shuffle press and makes the filter interaction feel instant.

**Trade-off:** If the list grew very large (thousands of items), this would need revisiting. Not a concern for a personal creative list.

---

## D-047: Sortie sensitive-path guardrails are two-tier — an authoritative, runtime-independent CI path-guard (Tier 1) plus a runtime-coupled in-loop Claude Code layer (Tier 2), both fed by one shared denylist (PD-308, PD-312; supersedes C-2, PD-13, C-15)

**Decision:** Bounding what an autonomous Sortie worker may change **inside the repo** is enforced in **two tiers**, split by whether the layer survives an agent-runtime swap:

- **Tier 1 — authoritative, runtime-independent (PD-308).** A CI **path-guard** at the git/GitHub boundary: a required GitHub Actions check that goes red when a PR's diff touches any path in a shared denylist (`.github/sensitive-paths.txt`), **unless** a write+ collaborator applies a `sensitive-change-approved` label. It runs **base-ref** (`pull_request_target`) so a PR cannot weaken the guard or the list within the same PR. Because it inspects the **diff, not the agent**, it holds regardless of which runtime produced the commit. Branch protection already covers *direct-to-main* runtime-independently; `--no-verify` is moot (CI re-runs `verify`); `push --force` only ever touches the agent's own `sortie/<id>` branch.
- **Tier 2 — in-loop, runtime-coupled (PD-312).** Claude Code `permissions.deny` (generated from the same denylist) + a PreToolUse hook that degrades a block into an **`ask_human` park** (PD-241) rather than a hard fail. Provisioned in **managed settings baked into the container image** (`/etc/claude-code/managed-settings.json`, root-owned; the agent runs non-root, uid 1001) so the agent cannot edit its own guardrail. Its job is early feedback + UX, **not** the boundary — on a runtime swap it evaporates and must be re-implemented for the new runtime; Tier 1 keeps protecting meanwhile.
- **One shared denylist.** `.github/sensitive-paths.txt` is the single source of truth both tiers consume (the CI guard reads it; the Claude Code deny rules are generated from it). This is the useful residue of C-2's "policy artifact" idea — runtime-independent, maintained once. Self-protecting: `.github/**` and `ops/sortie/**` are in the list, so the agent can't quietly widen its own allowance.
- **Scope.** In-repo sensitive-path + dangerous-command protection only. "Writes **outside** the sandbox" are already contained by container isolation (no path to `/core`) + the squid egress allowlist (PD-30) and are explicitly out of scope — which is why C-2's original "processes touching files outside `/core`" framing does not map to the real residual risk here.

**Why:** Today the only structural controls are container isolation + squid egress; every "don't touch secrets/auth/CI/schema/deps" rule is **prompt-only** (`ops/sortie/WORKFLOW.md`), which is untrustworthy for an unsupervised agent. #192 (2026-07-07) was a live near-miss — the agent tried to edit `.github/workflows/sortie-watchdog.yml` and **only a missing token scope** stopped it, an accident rather than a designed guardrail. Putting the authoritative layer at the git boundary answers the portability question directly: a future Claude Code → Qwen/Ollama runtime swap must not silently disable protection, and a diff-inspecting check is agent-agnostic. The runtime-native layer is kept only as swappable early feedback.

**Trade-off:** Two layers + a shared list is more moving parts than simply configuring Claude Code permissions (the single-tier option) — accepted because single-tier is **silently** runtime-coupled and evaporates on a swap with no warning. A deliberately broad denylist means legitimate sensitive changes (e.g. #192's watchdog edit) go red and need an explicit human ack label — accepted; that friction **is** the control.

**Trade-off (grill provenance):** Combined + refined from C-2/PD-13/C-15 in a 2026-07-07 grill session. The reframe from C-2's "outside `/core`" to "in-repo sensitive paths" was the pivotal move; the two-tier split fell out of the "what if we switch off Claude Code?" question.

**Implications:** Combines + **supersedes C-2, PD-13, C-15** (closed, folded into PD-308). Split into **PD-308** (Tier 1, P1) + **PD-312** (Tier 2, P2). New repo artifacts: `.github/sensitive-paths.txt`, a base-ref path-guard workflow, the `sensitive-change-approved` label, a branch-protection required check; later the managed-settings + PreToolUse hook in the Sortie image. The denylist is drawn against the current NAS/Docker-on-Synology layout — **PD-311** (P1, Mac Mini Migration epic PD-188) re-evaluates it post-migration. PD-241 (`ask_human` park/resume, verified) is the degrade path Tier 2 falls back to. Glossary terms (*sensitive path*, *path-guard*, *guardrail tier*, *`sensitive-change-approved`*) added to PROJECT.md §8.

---

## D-046: Sortie's `after_run` safety-net publishes a hand-off ONLY when the agent earned it (a green-verify marker), never a mid-work tree (PD-299)

**Decision:** The `after_run` hook (WORKFLOW.md) gates PR-creation on a positive **hand-off-earned signal**: the agent writes `.sortie/verify-ok` the instant `npm run verify` goes green (Finish step 1), and the hook completes a cut-off hand-off (commit stragglers → push → `gh pr create` → `scm.json`) **only if that marker exists**. With no marker, a turn that ended before a green verify leaves uncommitted WIP; the hook does **not** sweep it into a commit/PR — it leaves the work for a retry and (if a WIP tree is present) drops one explanatory issue comment. `.sortie/` is now gitignored so neither the marker nor `scm.json` can leak into a commit.

**Why:** The hook's firing condition was **"changes present + no `scm.json` ⇒ finish the hand-off"**, which is *equally true* for "agent finished but the hand-off plumbing got cut off" **and** "the turn ended mid-work." So `git add -A && git commit` swept an unfinished tree into a generic `sortie(N): automated changes` PR that failed CI — bypassing the agent's own Finish contract, which explicitly says *"prefer `ask_human` over shipping a red PR."* PD-290 (issue #170, PR #174) proved it: the agent's turn ended before it could resolve a single `svelte/no-at-html-tags` lint error, the issue was even labeled `sortie:stuck`, yet the safety-net published the broken PR anyway. The marker is the one signal that distinguishes *earned* from *unfinished*, and it is written early (right after verify) so it survives a context-cancel that kills the later push/PR/relabel steps — exactly the crash window the hook exists to cover.

**Trade-off:** If a future agent forgets to write the marker on a genuinely-complete run, the backstop won't fire and the work needs a re-queue — accepted, because that failure mode is strictly safer (a missing PR the human re-queues) than the one we're removing (a broken PR that looks review-ready). The marker is a convention the prompt must keep writing; it is not enforced by the SDK.

**Implications:** WORKFLOW.md `after_run` + Finish step 1 changed; README safety-net description updated; `.gitignore` adds `.sortie/`. **The Sortie host must be redeployed** (WORKFLOW.md is read at dispatch, so the fix only takes effect after the host's workflow file is updated). Does not change the normal path (the agent still does its own durable hand-off in-turn per [[D-044]]/D-016); this only narrows when the backstop acts.

---

## D-045: The Ticket Audit is an autonomous, recurring **agent-worker** job that produces sticky, human-approved recommendations over the backlog — read-only run, human-gated apply, verify-and-confidence-gated for trust (PD-281)

**Decision:** A recurring backlog review, implemented as a **second job on the agent-worker** (the griller worker generalized — see D-044 and PROJECT.md §8; refine + audit share the checkout / egress proxy / API key / cached context-pack). Key choices:

- **Autonomy mode is per-job.** Refine is interactive + approval-gated; the **audit is autonomous + recurring but read-only** — the run only *produces recommendations*; every mutation is gated behind a human **Accept** in the web UI. So it sidesteps [[D-039]]'s backlog-only rule the same way [[D-044]]'s Refine does: **autonomous read, human-approved write.** No agent is ever in the apply path.
- **Trigger & run shape.** A server-side `node-cron` job writes an `audit_run` row (**weekly, Mon 05:00, interval configurable**); the agent-worker polls, **claims it atomically** (`requested`→`running`; a trigger fired mid-run is coalesced, not stacked), **`git pull`s the shared checkout**, then fans out **one agent per project → one pooled adversarial verify pass → synthesize**. A **"Run now"** button writes the same trigger row on demand (same pattern as D-043's on-demand sync).
- **Two entities.** `audit_run` = an immutable execution record (when / scope / model / cost / bucket counts) — the "recent runs" list. `audit_finding` = a **living, sticky** recommendation. A run **reconciles** rather than replaces: unchanged finding → **keep the prior decision**; changed evidence → resurface `undecided`; no longer flagged → close; new → `undecided`. Dedup key is `(ticket, type)` for single-ticket findings and `(from, to, relation_type)` for LINK/UNLINK (a ticket may carry several). Decision states: undecided / accepted / rejected / other. **Rejected-but-identical stays suppressed** (fingerprint over type + normalized evidence + proposed change) and resurfaces only when the evidence changes.
- **Recommendation types & apply mechanics.** `ARCHIVE` / `COMPLETE` / `REPRIORITIZE` are **one-click field-writes**. `UPDATE_DESCRIPTION` requires the agent to emit a **full proposed body** and Accept opens a **diff to confirm** — rewritten prose is never auto-applied (the highest hallucination risk). `LINK` / `UNLINK` write/remove `agent_ticket_relations` rows (one-click). A **duplicate-archive does both** (archive + write the `duplicates` relation, preserving lineage per [[D-044]]). The audit **reads existing relations as ground truth** — it stops inferring dependencies from prose (the brittle thing the manual run exposed) — and may propose `blocks` / `relates` / `duplicates` (never `split`, a Refine artifact).
- **Trust controls (the asset that kills the feature if lost).** (a) An adversarial **verify stage** over the pooled non-KEEP findings each run **drops or downgrades** anything not defensible against its cited evidence (the "Oracle" step, generation ≠ evaluation). (b) **Confidence gates the one-click:** `high` → one-click; `medium`/`low` → Accept is disabled until you open the ticket/diff. The confidence label is load-bearing, not decorative.
- **Three verbs.** **Accept** (apply) / **Reject** (dismiss + suppress; carries an *optional reason* that feeds the next run's suppression context) / **Send to Refine** (writes a refine trigger row; moves a backlog finding to `prioritized` as part of the handoff — see the D-044 amendment below). Audit surfaces candidates; Refine works the ones that need a conversation.
- **Surface.** Dedicated route `/reports/task-audit` = the **living view** of open findings (the nav-link badge = count of **undecided actionables**, an inbox that clears); `/reports/task-audit/:runId` = per-run read-only permalinks. Task Monitor keeps a compact **"Recurring Jobs → Ticket Audit"** card (last run, history, Run-now, View Report). On completion, **one Notification Center notification only when there are new/changed actionables** (silent otherwise — no "0 new" nag).

**Why:** A manual dogfood run (2026-07-05, 206 active tickets across PD + Core) proved the report is high-signal and that **stale descriptions dominate the real findings** (12 `UPDATE` vs 3 `ARCHIVE`) — bodies drift faster than status — and that inferring dependencies from prose is brittle, which motivated reading relations as truth once they became first-class. Everything the audit needs already exists in the agent-worker (PD-266), so a standalone worker would only duplicate infra; per-job autonomy lets one worker safely host an interactive and an autonomous job. Sticky findings + suppression make the badge an honest inbox rather than a re-nagging list; the verify pass + confidence gate protect trust in the report, without which the feature is dead.

**Trade-off:** An extra verify agent per run + requiring a full proposed body for every `UPDATE` finding raise per-run cost — accepted because **weekly** cadence makes cost negligible and both directly buy safety/trust. Findings persisting across runs adds reconciliation complexity vs. throwaway per-run reports — accepted as the price of the inbox behavior PROJECT.md asks for.

**Implications:** Generalizes the griller worker → **agent-worker** (PD-266 built it as `apps/griller`; rename + a `jobs/{refine,audit}` split). New tables `audit_run` + `audit_finding`; new route namespace `/reports/*`. **Depends on PD-250** (Notification Center, for the completion notification) and the **relations PR** (`RelationType` `relates`/`duplicates` + write path, PD-156 territory, for LINK/UNLINK). **Amends [[D-044]]** — Refine relaxed to launch from a **backlog or prioritized** ticket (was prioritized-only), so "Send to Refine" can escalate a backlog finding. Glossary (agent-worker, Job) added to PROJECT.md §8.

---

## D-044: Grill/Refine is a dashboard-owned, interactive, async triage agent launched from a "Refine" button — reinstating an interactive Refine step (reverses [[D-038]]'s drop) but async-over-notifications, not [[D-033]]'s synchronous SSE modal (PD-172, PD-245, PD-250, PD-255)

**Decision:** The pre-dispatch refinement step ("Grill" — the interrogation activity; "Refine" — the whole session) is a **dashboard-owned interactive agent**, distinct from the in-run `ask_human` grill ([[D-038]]). A **Refine button** on a `prioritized` card launches an Opus-backed session that grills Steve, plans, and — on Steve's explicit approval — either **refines the ticket in place** (single ticket) or **decomposes it into child tickets**, routing each to **Robot's Queue** (`robot_queue`, assignee `robot`) or **Steve's Queue** (`steve_queue`, assignee `steve`). Key choices:

- **Interactive + approval-gated ⇒ may queue.** The distinguishing axis is *autonomy mode*, not agent-vs-human. **Autonomous** agents (dispatched Sortie workers) stay backlog-only ([[D-039]]) because prompt-based limits are untrustworthy unsupervised (token-blowout risk; the real cap is PD-244). The Refine agent is *always* working with Steve in the loop, so human approval is the enforcement and it may create + queue tickets directly. No dependency on PD-244.
- **Async over the notification plane, not a synchronous modal.** The conversation is a **persistent thread on the ticket** (`agent_ticket_events`), surfaced through the Notification Center ([[D-040]], PD-250) and the ticket-detail page (PD-255). Steve dumps a ticket, presses Refine, and comes back to a notification (plan / follow-up questions / "needs a full grill"). This reinstates the interactive Refine step [[D-038]] dropped, but sidesteps [[D-038]]'s two objections: (1) the "one grilling system" argument was wrong — `ask_human` clarifies one ticket in place and **cannot decompose or route**, so Refine and `ask_human` do different jobs; (2) a synchronous modal blocks an often-AFK Steve, but async triage does not (the AFK coding loop stays `ask_human`). The remaining [[D-038]] objection — infra weight — is accepted as the price of the decompose/route capability, but paid down: no SSE, reuses the notification transport, thread persisted in an existing table.
- **Runtime: a dedicated griller worker, not the web process.** Separate process/container (Agent SDK), isolating the `ANTHROPIC_API_KEY` and long LLM turns from Fastify, egress-scoped like Sortie. Grounds against a **shared read-only repo checkout** (periodic `git pull`) — the griller only reads, so no per-session clone ([[D-033]]'s clone-per-session was for writable workspaces). Web↔worker coordination is **DB rows** (Refine button writes a trigger row; reply box writes comment rows the worker consumes) — the DB is the queue, no new IPC. A **warm in-memory session per active ticket** (in the worker, which survives web redeploys) gives snappy turns during active back-and-forth; cold turns rehydrate the thread from the DB.
- **Token cost is bounded by prompt caching, not process lifetime.** The Messages API is stateless — history is re-sent every turn regardless of "live chat" vs "per-turn". What controls cost is caching: a compact **project-context prefix** (PROJECT.md §8 glossary/conventions + a tool/widget index) cached at ~0.1× read, plus **on-demand repo-search tools** rather than preloading the codebase. The only real cost is a cold-cache re-read after an async gap exceeds the TTL (use the 1-hour TTL during active sessions).
- **Commit step.** Robot-bound children are emitted **`isSortieReady`-shaped** (`## Context / ## Task / ## Done When / ## Out of scope`, PD-177) so `robot_queue` dispatch (PD-164 issue-mint → Sortie) is safe; `steve_queue` children may be looser. On a genuine split, the **parent is closed** (`closed`, [[D-036]]) with children linked via **`agent_ticket_relations`** (from [[D-020]]) — lineage stored now means epics/subtasks are a later presentation layer, not a migration. A **server-enforced lane→assignee invariant** (entering `robot_queue`⇒`robot`, `steve_queue`⇒`steve`) makes "queue = assigned" true in the data layer for *any* writer (griller, manual drag, future path), not just the griller; assignee stays a free optional hint in backlog/prioritized.

**Why:** The [[D-040]]/PD-245 board redesign created a concrete need for a *producer* that decomposes + routes tickets — a need [[D-038]] underweighted when it collapsed refinement to the mechanical `isSortieReady` gate + in-run `ask_human`. `ask_human` structurally can't fill it. Keeping the producer interactive + approval-gated resolves the apparent [[D-039]] contradiction (backlog-only governs *autonomous* writes) without waiting on PD-244, and the async-over-notifications shape fits a solo, often-AFK human better than either a blocking modal or a Sortie-based refinement (which would burn the coding worker's `max_sessions`).

**Trade-off:** A dedicated worker + repo checkout + an API key in a new surface is real infra (the [[D-038]] concern), accepted because the decompose/route capability has no cheaper home and the async transport is already built (PD-250) / planned (PD-255). A change refined <TTL after the last turn pays one cold-cache re-read — negligible.

**Implications:** Supersedes [[D-038]]'s "Refine sidecar dropped" clause (the mechanical `isSortieReady` gate + in-run `ask_human` from D-038 remain) and replaces [[D-033]]'s synchronous SSE modal with the async ticket-thread shape (D-033's propose→approve→server-writes and clone-grounding survive in modified form: approval-gated, shared read-only checkout). Depends on PD-250 (shipped) and PD-255 (thread surface). Relates to PD-156 (relations UI) — the griller writes relations; PD-156 renders them, and should account for the parent/child relation type. Independent of PD-244 (autonomous agent-creation + depth cap), which remains the gate for the *autonomous* queuing path. See [[D-039]] for the ticket↔issue authority model and [[D-040]] for the notification transport.

**Amended by [[D-045]] (2026-07-06):** the Refine session may now launch from a **backlog or prioritized** ticket (was prioritized-only), so the Ticket Audit's "Send to Refine" can escalate a backlog finding. The generalization of the griller worker into the **agent-worker** (host for both the refine and audit jobs) also originates in D-045.

---

## D-043: Board reflects GitHub changes via an on-demand sync trigger (page-load + "Sync now"), not just the once-a-minute cron (PD-252)

**Decision:** The Task Monitor board triggers a server→GitHub reconciliation **on page load and via a "Sync now" button**, in addition to the existing `* * * * *` cron. New endpoint `POST /api/widgets/agent-dashboard/sync` runs `runGithubSync` on demand; the frontend calls it on mount, then re-reads tickets. The trigger is guarded by `requestGithubSync` — concurrent callers **coalesce** onto one in-flight pass, and calls within 10s of the last pass are **throttled** — so refresh spam / many open tabs can't hammer GitHub's rate limit.

**Why:**

- **Issue status & labels are GitHub-owned** and only land in the DB via the cron ([[D-040]] Notification Center, PD-165 label→status sync). So closing an issue on GitHub took up to ~60s to show — and crucially, **neither a hard refresh nor the 30s client poll could beat it**, because both only re-read the not-yet-synced DB. The staleness was server-side, not a fetch/cache bug.
- **Webhooks are the "right" push fix but aren't reachable today** — PD is LAN-only and external ingress is explicitly out of MVP scope (webhooks need inbound exposure; contrast web push in [[D-040]], which is outbound-only). On-demand pull needs no ingress.
- **A guard, not raw triggering,** keeps the GitHub API budget safe: authenticated limit is ~83 req/min and each pass costs one request per linked ticket, so uncontrolled per-refresh pulls could blow the budget. Coalesce + 10s throttle bounds it while still making "I just closed it → refresh → it's there" work within seconds.

**Trade-off:** a change made <10s after a prior pass can be throttled and miss that refresh; acceptable — 10s is a large improvement over 60s and the next poll/refresh catches it.

---

## D-042: Sortie review re-work moves from the native `reactions.review_comments` to an in-repo Actions bridge (PD-256)

**Decision:** Disable Sortie's native `reactions.review_comments` and drive PR-feedback re-work
from a new in-repo GitHub Actions workflow, `.github/workflows/sortie-review-rework.yml`. On a
trusted human review or comment on a `sortie/*` PR it flips the linked issue
`sortie:in-review` → `sortie:queued`; Sortie re-dispatches a normal run, `before_run` reuses the
existing branch, and the prompt's "check for an open PR" step (Step 2B) reads the feedback off the
PR and pushes fixes. Also bumped `agent.max_sessions` 3 → 5.

**Why:** The native reaction was silently dropping feedback. Root-caused live for PD-256: the
reaction only arms its watch-set at the process-startup "pending reaction recovery" pass — one per
container **restart**. An issue that hands off to `sortie:in-review` *between* restarts is never
watched, so a review/comment on its PR does nothing until the next restart. Proven on issue #132
(handed off 12m after a restart; a "Request changes" review 17h later did nothing; a manual restart
re-armed it and it immediately re-worked). Second defect: the native reaction only fired on a
`CHANGES_REQUESTED` review — never a plain PR comment or a "Comment" review — so most of the ways
feedback is actually left never triggered re-work. The bridge runs in GitHub Actions (not coupled
to container restarts) and broadens the trigger set to Request-changes, Comment reviews, inline
review comments, and top-level PR comments (a pure Approve is excluded).

**This reverses the D-016-era note** in the old README/WORKFLOW that a label flip was *worse* than
the native mechanism ("a flip would stop reactions by moving the issue out of `handoff_state`").
That reasoning only held while we depended on the native reaction; now that it's disabled, the
label flip is the mechanism — the same proven pattern as `sortie-conflict-rework.yml`.

**Loop safety:** only the repo OWNER (or a COLLABORATOR carrying the `<!-- sortie:human-reply -->`
marker) triggers it; the bot's own comments and the workflow's confirmation comment are excluded;
flipping out of `in-review` makes duplicate events no-ops; per-issue `max_sessions`/`max_tokens`
still cap re-work cycles.

**Alternatives rejected:** (a) keep the native reaction and just restart the container on a cadence
— fragile, and still change-requested-only; (b) run both native + bridge — risks double-dispatch if
the native poller wakes after a restart. Single source of truth is the bridge.

**Deploy:** the workflow is live only once merged to `main`; disabling the native reaction +
`max_sessions: 5` needs a container **recreate** (not restart), per README Step 4.7.

---

## D-041: Cmd+K shortcut uses metaKey-only (no Ctrl+K fallback) and toggles search focus (PD-126)

**Decision:** The `⌘K` keyboard shortcut on the Task Monitor board only checks `e.metaKey` (Mac Command key), not `e.ctrlKey`. Focus is toggled: pressing again while the search is focused blurs it.

**Reasoning:** The issue specifies "Mac(Command)+K". Ctrl+K is used by browsers on some platforms to focus the URL/search bar, so adding a Ctrl+K fallback could interfere. The toggle behavior (focus → blur on second press) is standard command-palette UX and avoids a second shortcut to dismiss.

**Alternative:** Support `metaKey || ctrlKey` to cover Linux/Windows. Rejected for now since this is a personal Mac-only dashboard.

---

## D-040: Agent + widget notifications go through a dashboard-native Notification Center with a pluggable delivery transport; web push is primary, Discord is demoted to an optional adapter (PD-6, PD-142, PD-242, PD-243)

**Decision:** Notifications — agent `ask_human`/`needs-human` parks, PR-ready pings, reminders, and per-widget alerts — are handled by **two layers**, not a Discord integration:

- **Notification Center — a dashboard-native store + surface.** Messages/questions live in the dashboard next to the ticket/widget they belong to, are marked read/actioned, and (for agent questions) answered **inline** — an inline reply posts the GitHub issue comment that re-queues the parked agent (the inbound loop verified in PD-241). This is the durable source of truth and **subsumes PD-243** (surface `ask_human` on the board). It serves every "notify me" need on the board, not just agents (reminders PD-158, pomodoro PD-137, music-tracker PD-131, habit PD-107, agent-agent visibility core C-3).
- **Delivery transport — pluggable, web-push-primary.** The "reach me when I'm AFK" leg is a swappable adapter behind the Center. **Web push (service worker + VAPID, PD-142)** is the primary transport; Discord (PD-6) is demoted to an optional adapter or dropped.

**Why:**

- **Center-alone can't reach an AFK human; transport-alone is a poor surface.** They're different layers — a store/surface vs. a delivery channel — and D-038's async grill needs both.
- **Web push is outbound-only.** Delivery is dashboard-server → the browser vendor's push service → the installed PWA on the device, so the dashboard needs **no inbound exposure**: it reaches phone/desktop **off-LAN today without a reverse proxy** and without exposing the box — the exact requirement Discord was there for, met natively. The app is already a PWA (`manifest.webmanifest`) and PD-142 already planned web push.
- **No external dependency, data stays local, richer surface.** Agent questions stay on Steve's infra; the Center carries `sortie:*` state + threaded history (`agent_ticket_events`) and supports inline actions — none of which a Discord chat log does well.
- **One system for many needs.** A single Center + transport serves reminders, pomodoro, music-tracker, habit, and agent messages; a Discord integration would serve only the agent slice while adding a third-party account.

**Trade-off:** Web push is more upfront build than a one-line Discord webhook (VAPID keys, service worker, per-device opt-in; iOS requires the PWA be home-screen-installed, 16.4+). Accepted for the better end state; Discord may still serve as a *temporary* transport to get the async loop live before the Center lands, then be retired. **Shared prerequisite (from PD-241):** `sortie-ask-human.yml` gates the re-queue on `comment.user.login == 'scolacur'`, so an inline dashboard/bot reply (authored by the bot, not the owner) must be accepted by widening that gate — true for any non-owner-authored reply, Discord or dashboard.

**Implications:** Reframes PD-6 (Discord) as an optional adapter, not the plan; elevates PD-142 (web push) from a Reminders-widget feature to the general delivery transport; PD-243 folds into the Notification Center; PD-242 (notify-on-park) becomes a consumer of the Center + transport. New tickets: Notification Center (store + inbox + inline reply) and the web-push delivery transport. Depends on widening the `ask_human` reply gate (PD-241/PD-242 caveat). See [[D-038]] — the pipeline that needs this notify leg.

---

## D-039: Board↔issue authority — ticket is the durable spec, issue is an execution lease; ticket stays amendable post-queue; agent-created tickets are backlog-only, queuing gated by a server-computed depth cap (PD-207, PD-232)

**Decision:** Defines who owns a ticket's content across its lifecycle, resolving the question [[D-038]]'s async-grill pipeline raised:

- **The ticket is the durable spec; the GitHub issue is an execution lease.** At Queue the issue is minted from the ticket (PD-164, unchanged), but the ticket does **not** freeze. Post-queue edits and `ask_human` answers are written **back into the ticket body** (so the durable record improves) and **propagate to the linked open issue** via the write token. There is no 409 content-lock. *(This reworks PD-207 part B, which had specified a hard freeze-at-queue on the now-rejected premise that the issue becomes the sole operative spec.)*
- **Deletion is ticket-authoritative.** Archiving a ticket closes its linked issue as `not planned` (PD-207 part A); a GitHub-side delete never deletes the ticket — it only unlinks it (PD-207 part C). *(Parts A + C are built; part B — propagation — is deferred behind the board redesign.)*
- **Agent-created tickets are backlog-only for now.** A Sortie worker that decides a ticket is really several may create child tickets, but only into `backlog` — never a queue lane. A human advances them. This structurally prevents runaway self-dispatch.
- **Queuing is gated by a server-computed depth cap, enabled later.** When an agent→dashboard ticket-creation path is built, `agent_tickets` gains `spawned_by_ticket_id` + `agent_queue_depth` (server-computed as `parent.depth + 1`, **never agent-supplied**). Agent-queuing is allowed only when the result is `≤ 1` ("one level of agent queuing"); deeper spawns can still be created into backlog. Enforced at the queue transition.

**Why:**

- **Async grilling requires a mutable spec.** [[D-038]] moves clarification *after* dispatch, so the spec keeps evolving while the issue is open; a freeze-at-queue would strand those answers in issue comments instead of improving the ticket. Ticket-as-durable-spec keeps the board the source of truth.
- **Least-authority loop-breaking.** Backlog-only agent creation makes the infinite-dispatch loop impossible by construction (a spawned ticket cannot dispatch itself). The depth cap is the graduated relaxation for once a verified agent identity exists.
- **The cap must be unforgeable to be worth anything.** Depth is server-computed from a **server-verified parent** (the issue the agent's run is scoped to), not an agent-declared field — otherwise an agent could reset its own depth. Hence the cap ships with, and depends on, the agent-auth design; until then agent ticket-creation does not exist at all, and backlog-only vs. capped-queuing are the same zero code on the agent side.

**Trade-off:** Propagating ticket edits to an open issue adds a write path and a small divergence window (ticket and issue can briefly differ between polls) — accepted over a freeze, which the async pipeline can't tolerate. Backlog-only means a human must advance agent-split tickets even when they're obviously fine — accepted as the safe default until the depth cap + agent identity land.

**Implications:** Reworks PD-207 (parts A + C build as-is — done here; part B becomes "propagate post-queue ticket edits to the linked issue", deferred behind the board redesign). Follow-on: agent ticket-creation API with server-verifiable identity + `spawned_by_ticket_id`/`agent_queue_depth` columns + the `≤ 1` queue guard. Columns are additive (D-021 migration framework). See [[D-038]] for the pipeline this serves.

---

## D-038: Issue pipeline is hybrid — mechanical `isSortieReady` gate + async in-run grill via `ask_human`; the heavyweight Refine sidecar (D-033) is dropped (PD-232)

**Decision:** The backlog→Ready→Queued→dispatch pipeline drops the interactive **Refine sidecar** ([[D-033]], PD-172) as the refinement mechanism. Refinement instead happens in two cheaper places:

- **A mechanical shape gate at Queue** — the existing Claude-free `isSortieReady(body)` validator (PD-177) warns when a ticket entering a queue lane lacks the `## Context` / `## Task` / `## Done When` / `## Out of scope` sections. This is the only *upfront* gate; it costs nothing and needs no agent.
- **Async clarification during the run** — when the dispatched Sortie worker hits a real ambiguity it uses `ask_human` (post `### ❓ ask_human`, self-relabel `sortie:awaiting-human`, park), the human is notified (Discord, PD-6) and replies async, and the worker resumes. The grill is grounded in the *actual* task by the agent that will do the work.

**Why:**

- **`max_sessions` economics.** `agent.max_sessions: 3` is enforced by counting `run_history` rows, and every re-dispatch — including each `awaiting-human` resume — consumes one, with no native knob to exempt a park (only quota-fails are refunded, and only after the window resets). So async grilling spends the *expensive coding worker's* retry budget on Q&A. The mechanical gate keeps obviously-unshaped tickets from ever reaching the worker, bounding how much of that budget clarification can eat.
- **One grilling system, not two.** Refine can't eliminate `ask_human` — a worker still hits real ambiguities mid-task — so keeping the sidecar means maintaining two grilling paths: one that *guesses* (Refine, upfront, against a prediction of the work) and one that *knows* (the worker, grounded in the real task). Collapsing to the in-run grill removes the guesswork path and a whole sidecar (SSE + clone-per-session + a second `ANTHROPIC_API_KEY` container).
- **Fits a solo, often-AFK human.** A synchronous modal grill blocks Steve at his desk; async park + Discord ping + reply-whenever matches how the system is actually used (and works off-LAN via Tailscale, PD-34).

**Trade-off:** A vague-but-`isSortieReady`-shaped ticket can still burn a coding session or two on clarification before any code lands. Accepted because the mechanical gate + a well-formed template make ≤ 1–2 rounds the common case, and the alternative (a full interactive sidecar) is materially more infra for a path the worker's own `ask_human` already has to cover. A *lightweight one-shot* "tidy into the four sections" formatter (single Claude call, not an interactive sidecar) may be added at backlog→Prioritized later if `isSortieReady` fails too often in practice — deferred until real tickets show the need.

**Implications:** Supersedes [[D-033]] (Refine sidecar not built); narrows [[D-032]] (the "formatting upstream in Refine" half is dropped; the mechanical Queued poller PD-164 is unchanged). The async grill depends on making the park/resume loop **real + e2e-verified** — today the `sortie:awaiting-human` label + `sortie-ask-human.yml` re-queue Action exist on `main` but are unverified, and the dashboard only *displays* the state (it does not forward the question, notify, or offer a reply path) — and on Discord notify (PD-6). Follow-on tickets: verify park/resume e2e, Discord notify, and a board-side `ask_human` question+reply surface. The grilling step also routes each produced ticket to Steve's Queue or the Robot's Queue and sets its assignee accordingly (see the board-redesign decision). See [[D-039]] for the ticket↔issue authority model this pipeline implies.

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

> **Amended 2026-07-17 (post-[[D-055]]):** the second stack this migration moves is no longer the
> third-party **Sortie** runtime — it's the dashboard's own **agent-worker** (the Robot loop + the
> Refine/Audit jobs, `ops/agent-worker/`). Consequences for the mechanics below:
> - **`/data` (and `dashboard.db`) lives on a Colima VM-native volume, not a macOS-host bind mount.**
>   A host mount reaches the container over virtiofs, which presents host ownership and flattens Linux
>   mode/uid semantics — it would silently break the D-055 uid-split (mode-`660` + `robot` uid-`1500`
>   exclusion is what kernel-enforces [[D-039]]: the coding session physically can't read the DB). A
>   VM-native ext4 path keeps that exclusion real, exactly as on the NAS. This is inherent to bridging
>   APFS↔Linux — **no** macOS Docker runtime (Colima/OrbStack/Docker Desktop) can preserve it on a host
>   mount, so the choice is runtime-independent. Trade-off: PD-190's off-box backup shipper must reach
>   *into* the VM for `data/backups/` rather than grab a plain macOS file.
> - **The agent-worker is built on-host** (deliberately NOT on GHCR/Watchtower — [[D-044]]), so the Mini
>   needs the build toolchain, and step 3 must **reproduce the uid-split**: loop runs as root (owns
>   `dashboard.db`), the coding session is dropped to uid `1500`, DB `chmod 660`. There is **no separate
>   `.sortie.db`** (the worker shares the web app's `dashboard.db`) and **no quota-refund cron** (the C2
>   fault-tier replaced Sortie's `max_sessions` economics; `ops/sortie/` was removed in C7).
> - **Disarmed bring-up.** Because the worker is now an *autonomous* coding agent, it comes up with
>   dispatch paused (`ROBOT_ALLOWLIST=NONE` / `ROBOT_DISPATCH_ENABLED=0`) and is **armed only after**
>   egress-jail + uid-split + one refine turn verify on Colima *and* the NAS loop is confirmed stopped —
>   mirrors the C1 prove-on-one discipline and prevents a double-loop against the queue during the
>   rollback window.
> - **Colima is unaffected** — Sortie's retirement touches none of its reasons, and the sudoless
>   per-user `docker` it brings actually *fixes* the NAS's password-gated `sudo docker` pain (why a
>   runaway run couldn't be killed over SSH). Its egress jail (squid `internal:` network) + the uid-split
>   are exactly why a Linux-VM runtime stays mandatory (native macOS would drop both). PD-200's OrbStack
>   re-eval stays on its ~1-month soak, decoupled from the cutover.

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
  `ROBOT_BOARD_URL`, `ops/` runbooks, compose) → `<mini>.local:8088`. (8080 is free without gluetun,
  but keeping 8088 avoids gratuitous reference churn.)
- **Data cutover: manual.** Stop both stacks → `VACUUM INTO` the DB (`dashboard.db`, now shared by
  web + agent-worker — folds the WAL, the D-025 lesson) → transfer NAS→Mini over `ssh cat` (NAS has no
  SFTP subsystem) → land it on the **VM-native `/data` volume** → checksum + verify (health, ticket
  count, `agent_runs` row counts) → **keep the NAS DB frozen as rollback** until the Mini is proven,
  then decommission. agent-worker egress containment re-verified on Colima (direct = blocked,
  proxied = 200 — same Linux Docker engine inside the Lima VM, so it ports as-is; a verify item, not
  a redesign).
- **Reboot recovery: auto-login + a LaunchAgent** that starts Colima → waits for `docker info` →
  brings up the dashboard stack → then the agent-worker egress stack (explicit order), with
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
