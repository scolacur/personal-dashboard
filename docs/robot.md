# Robot loop

> **History (D-055).** This loop is the in-house replacement for the retired third-party **Sortie**
> runtime. Sortie was a closed process the board could only observe through GitHub `sortie:*` labels;
> the four `sortie-*.yml` reaction bridges (watchdog, ask-human, review-rework, conflict-rework) and
> the once-a-minute label-sync cron are all gone, folded into the loop as native, DB-driven behavior.
> Dispatch and state now key off the board DB (`agent_tickets`), **not** GitHub labels. See
> `DECISIONS.md` D-055 for the cutover, and the Robot glossary in `PROJECT.md`.

The **Robot loop** is the autonomous coding-agent dispatcher that picks up board tickets and
produces PRs for the Personal Dashboard. It lives in `apps/agent-worker` as the `robot` job. The
Task Monitor board (`/task-monitor`) is the human-facing control surface; the board ticket
(`agent_tickets` row) is the durable unit of work, and each dispatched run gets a short-lived
GitHub PR.

This page is the wiki-style reference the `AGENT_STATE_DESCRIPTIONS` prose points at. It explains
the end-to-end loop, in-process stall detection, the `ask_human` flow, and how the board's
`agentState` values map to the card pills.

Everything here is grounded in the real code:

- Robot loop orchestrator: [`apps/agent-worker/src/jobs/robot/`](../apps/agent-worker/src/jobs/robot/)
- Board-state writes (the sole `dashboard.db` writer): [`board.ts`](../apps/agent-worker/src/jobs/robot/board.ts)
- Dispatch candidate selection: [`select.ts`](../apps/agent-worker/src/jobs/robot/select.ts)
- State/label types + descriptions: [`packages/shared/src/task-monitor.ts`](../packages/shared/src/task-monitor.ts)
- Architectural decisions cited below live in [`DECISIONS.md`](../DECISIONS.md).

> Terminology follows `PROJECT.md` §8 (Glossary): **ticket** = the durable spec owned by the
> board (`agent_tickets`); **issue** = the GitHub issue optionally linked to it; **run** = one
> dispatched attempt by the loop, producing a `robot/<issue>` branch and PR (D-039).

---

## The state machine: DB-native `agentState`

The board DB **is** the state machine (D-055). A ticket carries a coarse `status` lane and a
fine-grained `agentState`; the loop is the sole writer of both (`setAgentState` /
`completeTicket` in [`board.ts`](../apps/agent-worker/src/jobs/robot/board.ts)). There is no longer
any GitHub-label round-trip: the retired Sortie design coordinated purely by adding/removing a
single `sortie:*` label, and the dashboard mirrored those labels on a cron. Now the loop writes
`agentState` directly and the board renders it as a status pill on the card.

Under the D-040 board layout, **every non-terminal state maps to the single `robot_queue` lane**
("Robot's Queue"); the fine-grained state is carried by `agentState`. Terminal completion moves the
card to `completed`.

### `agentState` values (the pills)

`AgentState`, `AGENT_STATE_LABELS`, and `AGENT_STATE_DESCRIPTIONS` are defined in
[`packages/shared/src/task-monitor.ts`](../packages/shared/src/task-monitor.ts).

| `agentState` (pill) | Board `status` | Who sets it | Notes |
|---|---|---|---|
| `null` / `queued` | `robot_queue` | board on Queue entry; a re-queue sweep; a human re-queue | The **only** dispatchable states — the loop's candidate set (`select.ts`). |
| `working` | `robot_queue` | the loop, on dispatch | Only state that drives the active-work shimmer. Drops out of the candidate set. |
| `in-review` | `robot_queue` | the loop, on hand-off | A PR is open awaiting review; out of the candidate set, so not re-dispatched. |
| `stuck` | `robot_queue` | the **stall watchdog** (`stall.ts`) | Repeated stall/fault escalation; parked until a human acts. |
| `needs-human` | `robot_queue` | a fault the loop can't retry | A PR exists but a human must drive it home. |
| `awaiting-human` | `robot_queue` | the loop, via **`ask_human`** | Intentional, expected park — least urgent. |
| `done` | `completed` | the loop, on PR merge (`completeTicket`) | Terminal. Green "done" pill in the Completed lane. |

The dispatch filter is exactly: `agent_state IS NULL OR agent_state = 'queued'` (plus the
not-blocked / ready / allowlist gates in `select.ts`). Every other state drops the ticket out of
the candidate set — that is what makes `working` / `in-review` / `awaiting-human` / `stuck` safe
parks without any label bookkeeping.

### State transition sketch

```
                    board Queue entry / re-queue sweep / human re-queue
                                        │
                                        ▼
                                 queued ─────────────────────► (human drops it)
                                    │  ▲
                  loop dispatches   │  │  human answers ask_human (resume.ts sweep)
                                    ▼  │  human review feedback (pr-state.ts sweep)
                                 working ◄──┐        PR conflicts (pr-state.ts sweep)
                                  │   │   │  │
              ask_human (agent)   │   │   │  └──────────────────┐
                                  ▼   │   │                     │
                        awaiting-human    │            in-review ──► (merge) ─► done
                                     │     │                 ▲                   (terminal)
                          stall      │     │  loop hand-off  │
                                     ▼     └─────────────────┘
                                   stuck  (stall escalation; human re-queues or drops)
```

---

## End-to-end loop: dispatch → run → PR → review

1. **Dispatch.** Routing a ticket into **Robot's Queue** (`robot_queue`) makes it a candidate.
   `robotQueueCandidates` ([`select.ts`](../apps/agent-worker/src/jobs/robot/select.ts)) selects
   tickets that are `NULL`/`queued`, not blocked, ready, and on the allowlist. A soft ready-check
   warns if the ticket body lacks the four standard sections, but it does not block (D-038).

2. **Pick-up.** The loop polls on its own interval and picks the next candidate. On dispatch it
   writes `agentState = working`, opens a run (`startRun`), and cuts a `robot/<issue>` branch
   (`robot/t<ticketId>` if the ticket has no linked issue — see `branchFor`). Because `working` is
   not dispatchable, no second run can grab the same ticket.

3. **Work.** The loop provisions a fresh, disposable clone for the branch (uid-split from the loop
   under D-039, so the coding session never touches `dashboard.db`), reads `PROJECT.md`/`CLAUDE.md`,
   picks up any prior `ask_human` answer, does the work, and runs `npm run verify` (build +
   typecheck + lint + test) as its own gate. Burn is bounded per run by the loop's fault/budget
   guardrails.

4. **Finish / hand-off.** The coding session commits with a conventional-commit message, pushes
   `robot/<issue>`, and opens the PR (`Closes #N` + the standard review envelope). The loop records
   the hand-off and writes `agentState = in-review`. `in-review` is not an active state, so the
   ticket drops out of the candidate set and is not re-dispatched while its PR awaits review.

5. **Review loop.** Human feedback re-activates the ticket via the loop's DB-native reconciliation
   sweeps (below), which re-queue it (`agentState → queued`); the next dispatch reuses the existing
   `robot/<issue>` branch, reads the PR feedback, and pushes fixes. Merging the PR is the completion
   signal: `completeTicket` moves the ticket to `completed` with a `done` pill.

### The reconciliation sweeps (DB-native, replacing the Sortie Actions bridges)

Sortie drove re-work through in-repo GitHub Actions that flipped labels. The loop is the process
now, so re-work is handled by in-process sweeps that read and write `dashboard.db` directly — no
label flip, no GitHub round-trip:

- **`resume.ts`** — the `ask_human` resume sweep (replaces `sortie-ask-human.yml`). Detects a human
  answer landing in the Notification Center and re-queues the ticket (see the `ask_human` section).
- **`pr-state.ts`** — the review / conflict re-work sweep (replaces `sortie-review-rework.yml` and
  `sortie-conflict-rework.yml`). When a trusted human requests changes, or a push to `main` turns a
  `robot/*` PR CONFLICTING, it re-queues the ticket so the next run resolves it on the existing
  branch. A pure approval is deliberately **not** a re-work trigger.
- **`stall.ts`** — in-process stall detection (replaces `sortie-watchdog.yml`; see below).

**`robot-auto-merge.yml` remains active** as a pure GitHub-side merge workflow — it is not part of
the loop's state machine.

---

## The stall watchdog (in-process)

[`stall.ts`](../apps/agent-worker/src/jobs/robot/stall.ts) is the DB-native replacement for the
retired external `sortie-watchdog.yml`. The old watchdog watched **GitHub label age** because
Sortie was a closed process the board couldn't see into: it caught workspace-prep failures,
session-budget exhaustion, and container-restart orphans that left an issue silently parked with no
signal.

The loop **is** the process now, so stall detection is native. A run stuck in `running` past the
threshold, whose ticket is still `working`, is an orphan — the process died or restarted mid-run,
leaving a zombie run and a `working` ticket that the candidate query never re-picks (only
`NULL`/`queued` are dispatchable). The sweep closes the run and routes it through the **same fault
guardrail** a normal failure takes:

- A **first** stall is treated as transient → the ticket is re-queued for a fresh attempt.
- A **repeated** stall promotes to deterministic → the ticket is parked `stuck` with a
  Notification-Center entry (replacing the old watchdog's `@`-mention).

Two of the old watchdog's jobs are intentionally dropped: the queued-staleness sweep ("Sortie down
/ not dispatching") can't happen when the loop itself is the dispatcher, and the label-rescue job is
meaningless now that there are no state labels to lose (D-055).

---

## The `ask_human` flow

`ask_human` (D-038, D-040) lets a dispatched, unattended run hand a *decision* back to the human and
pause, rather than guess — for an ambiguous contract, two diverging valid designs, or work that
would touch forbidden areas (secrets, auth, CI, schema). It clarifies the **current** ticket in
place; it does not create or route tickets (that is **Refine**, a pre-dispatch activity — see
`PROJECT.md` §8).

**Outbound (the run parks):**

1. The run records a `robot_ask_human` event carrying its question, ideally offering concrete
   A/B options for a short reply.
2. It leaves the working tree clean (no speculative commit, no PR).
3. The loop writes `agentState = awaiting-human` and ends the run. That state is not dispatchable,
   so the ticket is not re-picked while waiting.

**Surfacing to the human (dashboard, D-040 Notification Center):** when a ticket newly enters
`awaiting-human` (or `needs-human`), the board raises an `agent_awaiting_human` /
`agent_needs_human` notification carrying the run's question. The human replies inline; the reply is
recorded as a `robot_human_reply` event on the ticket (`appendRobotReply`).

**Inbound (human replies → resume),
[`resume.ts`](../apps/agent-worker/src/jobs/robot/resume.ts):** the resume sweep detects a
`robot_human_reply` that post-dates the newest `robot_ask_human` and hasn't yet been consumed by a
later dispatch, then re-queues the ticket (`agentState → queued`). The next run reuses the existing
`robot/<issue>` branch (prior work intact) and the resume prompt hands the answer to the (DB-blind)
coding session. This is entirely a `dashboard.db` operation — no GitHub issue round-trip, no label
flip.

> **Watchdog interaction:** `awaiting-human` is left alone by the stall sweep, so an `ask_human`
> park can wait indefinitely without being escalated to `stuck`.

---

## `stuck` vs `needs-human` vs `awaiting-human`

These three "attention" pills look similar but mean different things (see also the memory note
_Sortie human-state labels_):

- **`awaiting-human`** — the run *chose* to pause and asked a question (`ask_human`). Expected,
  least urgent. Resumes automatically on your reply.
- **`stuck`** — the stall watchdog flagged a repeated stall/fault (the run didn't finish and gave no
  usable signal). Needs you to investigate and re-queue or drop it.
- **`needs-human`** — a PR exists but a human must drive it home; a fault the loop can't retry on
  its own, kept deliberately separate from the watchdog's `stuck`.

The Task Monitor's status legend modal lists recommended human actions for each of these three
(`AGENT_STATE_ACTIONS` in the board page).

---

## Related decisions

- **D-016** — hand-off is done by the run's coding session in-turn; the loop writes the state transition.
- **D-038** — hybrid pipeline: a mechanical ready-check gate + async in-run `ask_human` clarification.
- **D-039** — ticket is the durable spec; a run is one dispatched attempt; loop and coding session are uid-split.
- **D-040** — board layout (single `robot_queue` lane + `agentState` pill) + Notification Center.
- **D-055** — the in-house Robot loop replaces the retired Sortie runtime; the board DB is the state machine, not GitHub labels.
