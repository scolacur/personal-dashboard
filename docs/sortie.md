# Sortie integration

> **⚠️ Being retired (D-055).** The third-party Sortie runtime is superseded by the in-house
> **Robot loop** (`apps/agent-worker`, job `robot`). As of **C5/PD-346** the four `sortie-*.yml`
> reaction bridges (watchdog, ask-human, review-rework, conflict-rework) are **deleted** and folded
> into the loop as native, DB-driven behavior — dispatch keys off the board DB, not `sortie:*`
> labels. The Sortie container is stopped. This page still describes the retired Sortie mechanics for
> historical reference; the live design is D-055 + the Robot glossary in `PROJECT.md`. Full doc/label
> cleanup lands in C7. **`sortie-auto-merge.yml` remains active** (a pure GitHub-side merge).

Sortie is the autonomous coding-agent loop that picks up GitHub issues and produces PRs
for the Personal Dashboard. The Task Monitor board (`/task-monitor`) is the human-facing
control surface; a linked GitHub issue is the execution lease Sortie actually works.

This page is the wiki-style reference the `AGENT_STATE_DESCRIPTIONS` prose points at. It
explains the end-to-end loop, the watchdog, the `ask_human` flow, and how the GitHub
`sortie:*` labels map to the `AgentState` values shown as card pills.

Everything here is grounded in the real config/code:

- Sortie runtime config + agent prompt: [`ops/sortie/WORKFLOW.md`](../ops/sortie/WORKFLOW.md)
- Deployment/ops notes: [`ops/sortie/README.md`](../ops/sortie/README.md)
- In-repo GitHub Actions bridges: [`.github/workflows/sortie-*.yml`](../.github/workflows/)
- Board ↔ GitHub sync + label rules: [`apps/server/src/widgets/task-monitor/github-sync.ts`](../apps/server/src/widgets/task-monitor/github-sync.ts)
- State/label types + descriptions: [`packages/shared/src/task-monitor.ts`](../packages/shared/src/task-monitor.ts)
- Architectural decisions cited below live in [`DECISIONS.md`](../DECISIONS.md).

> Terminology follows `PROJECT.md` §8 (Glossary): **ticket** = the durable spec owned by the
> board (`agent_tickets`); **issue** = the GitHub issue minted from it at dispatch, an
> execution lease, not the spec (D-039).

---

## The state machine: `sortie:*` labels ⇄ `AgentState`

The GitHub issue label **is** the state machine — not the Sortie `:7678` API (D-020). Sortie,
the agent, the watchdog, and the Actions bridges all coordinate purely by adding/removing a
single `sortie:*` label. The dashboard is a **read-mostly mirror**: a once-a-minute cron plus
an on-demand pull (D-043) reads each linked issue's labels and derives the board `status` +
`agentState` in [`deriveState()`](../apps/server/src/widgets/task-monitor/github-sync.ts).

Under the D-040 board redesign, **every non-terminal `sortie:*` label maps to the single
`robot_queue` lane** ("Robot's Queue"); the fine-grained state is carried by `agentState` and
rendered as a status pill on the card. Terminal states move the card to `completed`/`closed`.

### Label → (board status, AgentState) mapping

Precedence is top-to-bottom (first match wins); see `LABEL_RULES` and the terminal short-circuits
in `deriveState()`.

| GitHub label / issue state | Board `status` | `AgentState` (pill) | Who sets it | Notes |
|---|---|---|---|---|
| `sortie:queued` | `robot_queue` | `queued` | board→GitHub sync on Queue entry; re-work bridges; a human re-queue | In `query_filter` — Sortie's dispatch candidate set. |
| `sortie:in-progress` | `robot_queue` | `working` | the agent, when it picks the issue up | Only state that drives the active-work shimmer. |
| `sortie:in-review` | `robot_queue` | `in-review` | the agent in-turn (Finish step); `rescue-labels` backstop | `handoff_state` — out of `query_filter`, PR open awaiting review. |
| `sortie:stuck` | `robot_queue` | `stuck` | the **watchdog** (`detect-stuck`) | Escalation; dropped from the candidate set until a human acts. |
| `sortie:needs-human` | `robot_queue` | `needs-human` | manual escalation / native `needs-human-review` signal | A PR exists but a human must drive it home. |
| `sortie:awaiting-human` | `robot_queue` | `awaiting-human` | the agent, via **`ask_human`** | Intentional, expected park — least urgent. |
| `sortie:wontfix` | `closed` | `null` | a human | Terminal. Maps to `closed` even if the issue is still open on GitHub. |
| `sortie:done` | `completed` | `done` | a human / merge | Terminal. Keeps the green "done" pill in the Completed lane. |
| _(issue closed, no terminal label)_ | `completed` | `null` | GitHub close | A closed issue is completed regardless of any stale non-terminal label. |
| _(no `sortie:*` label)_ | _(unchanged)_ | _(unchanged)_ | — | `deriveState()` returns `null` → "leave the ticket alone." |

`AgentState`, `AGENT_STATE_LABELS`, and `AGENT_STATE_DESCRIPTIONS` are defined in
[`packages/shared/src/task-monitor.ts`](../packages/shared/src/task-monitor.ts). The
board never writes these fine states — it derives them from labels (PD-165).

### State transition sketch

```
                    board Queue entry / re-work bridge / human re-queue
                                        │
                                        ▼
                                 sortie:queued ──────────────► sortie:wontfix (human, terminal)
                                        │  ▲
                     agent picks it up  │  │  human replies to ask_human (sortie-ask-human.yml)
                                        ▼  │  human review feedback (sortie-review-rework.yml)
                               sortie:in-progress ◄──┐        PR conflicts (sortie-conflict-rework.yml)
                                  │      │      │     │
              ask_human (agent)   │      │      │     └──────────────┐
                                  ▼      │      │                    │
                        sortie:awaiting-human    │            sortie:in-review ──► (merge) ─► sortie:done
                                         │        │                  ▲                          (terminal)
                                 watchdog│ stall  │  agent Finish    │
                                         ▼        └──────────────────┘
                                   sortie:stuck  (watchdog escalation; human re-queues or wontfix)
```

---

## End-to-end loop: labels → dispatch → PR → review

1. **Dispatch (board → GitHub, write).** Dragging/routing a ticket into **Robot's Queue**
   (`robot_queue`) is the dispatch trigger. `runQueuedSync()`
   ([`github-sync.ts`](../apps/server/src/widgets/task-monitor/github-sync.ts), PD-164)
   mints a GitHub issue (title+body verbatim) with `sortie:queued`, or adds `sortie:queued` to
   an already-linked issue that has no `sortie:*` label yet. A soft `isSortieReady()` warning
   fires if the ticket body lacks the four Sortie sections, but it does not block (D-038).

2. **Pick-up.** Sortie polls every 30s (`polling.interval_ms`). Its `query_filter` matches
   only `sortie:queued` / `sortie:in-progress`, and only write+ collaborators can apply labels,
   so a stranger's unlabeled issue never runs (authorization gate, WORKFLOW.md `tracker`). On
   pick-up the agent self-labels `sortie:in-progress`.

3. **Work.** The agent clones the repo into a disposable per-issue workspace, reads
   `PROJECT.md`/`CLAUDE.md`, checks for prior `ask_human` replies and an existing PR
   (follow-up vs first attempt), does the work, and runs `npm run verify` (build + typecheck +
   lint + test) as its own gate. Burn is bounded per issue by `max_sessions`, `max_tokens`, and
   `max_budget_usd` (WORKFLOW.md `agent`).

4. **Finish / hand-off (agent in-turn, D-016).** The agent itself — not a hook — commits with a
   conventional-commit message, pushes `sortie/<issue>`, opens the PR (`Closes #N` + a standard
   review envelope), writes `.sortie/scm.json`, and **relabels `sortie:in-progress →
   sortie:in-review` as its last action**. Ordering is load-bearing: `in-review` is not an
   active state, so applying it earlier can make Sortie's reconciler cancel the worker mid-turn.
   `after_run` is only an idempotent safety-net for a turn that died mid-hand-off.

5. **Review loop.** `sortie:in-review` is the `handoff_state`: out of `query_filter`, so the
   issue is **not** re-dispatched while its PR awaits review. Human feedback re-activates it via
   in-repo Actions (see below), which flip the label back to `sortie:queued`; the agent resumes
   on the **existing** branch (`before_run` reuses it), reads the PR feedback via `gh api`, and
   pushes fixes. Merging the PR closes the issue (`Closes #N`) → the board reflects `completed`.

### The in-repo Actions bridges

Sortie's native `reactions` are fragile or absent for the Dashboard's real feedback paths, so
re-work is driven by in-repo workflows that all use the same pattern — flip a `sortie/*` PR's
issue back to `sortie:queued` and let Sortie re-dispatch a normal run:

- **[`sortie-review-rework.yml`](../.github/workflows/sortie-review-rework.yml)** (D-042,
  replaces native `reactions.review_comments`): on a trusted human "Request changes" review,
  "Comment" review, inline review comment, or top-level PR comment, flips
  `sortie:in-review → sortie:queued`. A pure APPROVED review is deliberately **not** a trigger.
  The native reaction was disabled because it only armed its watch-set once per container
  restart, silently dropping feedback (root-caused in PD-256).
- **[`sortie-conflict-rework.yml`](../.github/workflows/sortie-conflict-rework.yml)**: on a push
  to `main` that turns a `sortie/*` PR CONFLICTING, flips `sortie:in-review → sortie:queued` so
  the agent merges `origin/main` and resolves the conflict on the existing branch.
- **[`sortie-ask-human.yml`](../.github/workflows/sortie-ask-human.yml)**: the inbound half of
  the `ask_human` flow (below).

**Loop safety** is uniform: only an issue in the exact expected state is re-activated, only a
`sortie/*` head branch qualifies, and only a trusted reply counts — the repo **OWNER**
(`scolacur`) directly, or a **COLLABORATOR** whose comment carries the
`<!-- sortie:human-reply -->` marker (the dashboard/Discord forwarder, see
`HUMAN_REPLY_MARKER`). The flip moves the issue out of the trigger state, so duplicate events
are no-ops. Per-issue `max_sessions`/`max_tokens` remain the hard ceiling on re-work cycles.

---

## The watchdog (stuck detection)

[`.github/workflows/sortie-watchdog.yml`](../.github/workflows/sortie-watchdog.yml) is a
**state-based, external** escalator. It exists because Sortie has several failure modes that
leave an issue silently parked in an active state with no human signal — it just stops,
invisibly:

1. Workspace-prep failure (the exit-128 clone loop) — the agent never starts.
2. `agent.max_sessions` exhaustion — Sortie stops dispatching, with no transition and no ping.
3. Container-restart orphan — the in-memory worker dies on restart but the issue stays
   `sortie:in-progress` (not in the dispatch set), so nothing re-picks it.
4. Sortie down / not dispatching — issues sit in `sortie:queued` forever.

None of these reach a hook or the native reactions, so the watchdog watches **label age, not
run outcomes**, catching all four.

### Thresholds (verified against the workflow)

The `detect-stuck` job runs on `cron: */15 * * * *` (every 15 min) and gives each active state
its own staleness clock, measured from the **most recent** `labeled <state>` timeline event
(so a bounce back into a state restarts the timer):

| State | Threshold | Env var in the workflow |
|---|---|---|
| `sortie:queued` | **20 minutes** | `THRESHOLD_QUEUED_MIN: '20'` |
| `sortie:in-progress` | **120 minutes** | `THRESHOLD_IN_PROGRESS_MIN: '120'` |

> **These match the PD-262 ticket** (queued > 20m, in-progress > 120m). Note the cadence: with a
> 15-min cron, effective detection latency is threshold + up to one interval, and GitHub cron is
> best-effort (can be delayed several minutes under load). A `workflow_dispatch` with
> `threshold_minutes` overrides **both**, and `dry_run` reports without changing labels.

On a breach the job clears the stale active label and adds **`sortie:stuck`** with an
`@scolacur` mention comment. `sortie:stuck` is **not** in `query_filter`, so the issue drops out
of Sortie's candidate set until a human re-queues it (`sortie:queued`) or drops it
(`sortie:wontfix`).

**Deliberately untouched:** `sortie:awaiting-human` (an intentional `ask_human` park — escalating
it would be wrong) and the terminal/hand-off states `sortie:in-review` / `sortie:done` /
`sortie:wontfix`.

### `rescue-labels` (second job in the same file)

A P1 hand-off backstop (D-016): if both the agent's self-relabel and Sortie's `handoff_state`
transition lose the race to a canceled worker context, an issue can end up with an open
`sortie/*` PR but **no** `sortie:*` label — invisible to both the review bridge and
`detect-stuck` (which only watches queued/in-progress). This job finds such label-less issues
and restores `sortie:in-review`. Idempotent: an issue that already carries any `sortie:*` label
is left alone.

---

## The `ask_human` flow

`ask_human` (D-038, D-040) lets a dispatched, unattended worker hand a *decision* back to the
human and pause, rather than guess — for an ambiguous contract, two diverging valid designs, or
work that would touch forbidden areas (secrets, auth, CI, schema). It clarifies the **current**
ticket in place; it does not create or route tickets (that is **Refine**, a pre-dispatch activity
— see `PROJECT.md` §8).

**Outbound (agent parks), from the WORKFLOW.md prompt:**

1. The agent posts an issue comment whose **first line is exactly** `### ❓ ask_human`
   (`ASK_HUMAN_MARKER`), ideally offering concrete A/B options for a short reply.
2. It leaves the working tree clean (no speculative commit, no PR).
3. It relabels `sortie:in-progress → sortie:awaiting-human` and ends its turn. That label is
   **not** in `query_filter`, so the worker is not re-dispatched while waiting.

**Surfacing to the human (dashboard, D-040 Notification Center):** when `runGithubSync()` sees a
ticket **newly** enter `awaiting-human` (or `needs-human`), it fetches the latest `### ❓
ask_human` comment via `fetchLatestAskHuman()` and creates an `agent_awaiting_human` /
`agent_needs_human` notification carrying the agent's question. The board can reply inline; the
reply is posted as a GitHub issue comment stamped with `<!-- sortie:human-reply -->`.

**Inbound (human replies → resume),
[`sortie-ask-human.yml`](../.github/workflows/sortie-ask-human.yml):** a reply on an
`awaiting-human` issue that is (a) not the agent's own `### ❓ ask_human` comment and (b) from a
trusted author (OWNER directly, or COLLABORATOR + marker) flips
`sortie:awaiting-human → sortie:queued`. Sortie re-dispatches; `before_run` reuses the existing
`sortie/<issue>` branch (prior work intact) and the prompt tells the agent to read the thread for
the answer. A future Discord phase is only an *input adapter* that posts the reply as a GitHub
comment — it triggers the same workflow.

> **Watchdog interaction:** `awaiting-human` is intentionally left alone by the watchdog, so an
> `ask_human` park can wait indefinitely without being escalated to `stuck`.

---

## `stuck` vs `needs-human` vs `awaiting-human`

These three "attention" pills look similar but mean different things (see also the memory note
_Sortie human-state labels_):

- **`awaiting-human`** — the agent *chose* to pause and asked a question (`ask_human`). Expected,
  least urgent. Resumes automatically on your reply.
- **`stuck`** — the watchdog flagged a *stall* (the agent didn't finish and gave no signal).
  Needs you to investigate and re-queue or drop it.
- **`needs-human`** — a PR exists but a human must drive it home; the native
  `needs-human-review` escalation label, kept deliberately separate from the watchdog's `stuck`.

The Task Monitor's "Sortie statuses" legend modal lists recommended human actions for each of
these three (`AGENT_STATE_ACTIONS` in the board page).

---

## Related decisions

- **D-016** — hand-off is done by the agent in-turn, not by `after_run`; label transition is last.
- **D-020** — cross-project ticket backlog; labels are the state machine, not the Sortie API.
- **D-038** — hybrid pipeline: mechanical `isSortieReady` gate + async in-run `ask_human` clarification.
- **D-039** — ticket is the durable spec; issue is an execution lease; tickets stay amendable.
- **D-040** — board redesign (single `robot_queue` lane + `agentState` pill) + Notification Center.
- **D-042** — review re-work moves from native `reactions` to the in-repo Actions bridge.
- **D-043** — board reflects GitHub changes via on-demand sync, not just the once-a-minute cron.
