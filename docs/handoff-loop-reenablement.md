# Handoff — Robot loop re-enablement (PD-468) and the work in front of it

*Rewritten 2026-08-06. Supersedes the 2026-08-04 version, which described a 17-blocker gate that no
longer exists. Ticket IDs are always given with their titles — bare numbers are unreadable.*

## The one thing to know first

**Robot dispatch has been paused since 2026-07-30** and every ticket since has been built by hand.
**PD-468 — [Robot] Turn the Robot loop back on** is the single gate for resuming it. Do not resume
piecemeal, and do not resume without walking its **go-live checklist**, which lives on the ticket body
and not in this doc (it is operational and changes; the doc goes stale, the ticket does not).

## Where things stand

The gate has gone **17 → 9** live blockers. Shipped since the pause, all by hand:

| Ticket | What it bought |
|---|---|
| PD-308 — Guardrail Tier 1, the CI sensitive-path guard | An agent can't merge CI/deploy/schema/dependency changes without a human ack |
| PD-393 — awaiting-human UX | The reply box names the question instead of describing a generic park |
| PD-467 — queued tickets stuck in `agent_state` | A parked state clears on queue entry, logged as `robot_unstick` so the retry budget resets |
| PD-470 — reset-aware retry (D-063) | A session limit holds the whole loop and **self-resumes**; no ticket is blamed, no budget burned |
| PD-463 — loop-wide budget ceiling (D-064) | Cumulative turn/token ceiling pauses dispatch before a runaway |
| PD-432 — per-ticket `max_turns` (D-066) | Refine estimates a turn budget; an easy ticket stops holding a 200-turn licence |
| PD-424 — auto-merge bridge deadlock | The bridge no longer waits on its own in-flight check. **Verified live on a bot-authored PR** |
| PD-482 — `ROBOT_GITHUB_TOKEN` was dead (401) | Found by trying to use it. Every hand-off would have failed at `gh pr create` |
| PD-394 — rework poll missed inline PR comments | Was already fixed in #255; verification found and fixed a page-ordering bug in it (#300) |

## The gate was over-drawn — read this before working any of it

A spot check on 2026-08-06 pulled every remaining blocker and checked it against the code. **Three
kinds of rot showed up, and they will show up again:**

1. **PD-394 was already done** — fixed 2026-07-17 in #255, the board row just never moved. A session
   was about to rebuild it.
2. **PD-162 — Activity Feed is largely realised.** `apps/web/src/lib/ActivityTimeline.svelte` ships a
   per-ticket timeline over `agent_ticket_events` (C3/PD-344). What does *not* exist is a board-wide
   cross-ticket feed, and there is no route for one (`/tickets/:id/events` is per-ticket only). The
   ticket reads much bigger than the work left.
3. **C-3 — User visibility into agent-agent communication is mis-filed.** Its `source` is
   `seed:core/META-TODOS.md` and its body is about Warren, Tank-as-router and `IMPROVEMENTS.md` —
   **harness** concerns. It carries `projectId: 1` (personal-dashboard) anyway, and from there it was
   made to gate a personal-dashboard go-live. It has nothing to do with the Robot loop.

**So: before building any ticket on this list, spend five minutes checking it isn't already done.**
Grep for the symbol the ticket names. It costs minutes and has now paid off twice.

### What is genuinely a blocker for turning the Robot on

The question that separates them: *does this change whether an unattended loop is safe or produces
good work?* Not *is it good to have*.

**True blockers — 4:**

| | Ticket | Why it gates |
|---|---|---|
| 1 | **PD-410 — UI killswitch (dispatch pause/resume in the nav)** | The thing you want *in hand* the moment you flip the switch. The pause already exists in Site Status; this makes it unmissable. Smallest of the four. **Currently P2 — it should be P1.** |
| 2 | **PD-306 — robot agents use `/harness` and `/wrap-up`** | Quality floor on *every* dispatched run. A Robot that never reads PROJECT.md or the project MEMORY re-derives context and contradicts settled conventions. Nothing in `prompt.ts` mentions either command today. |
| 3 | **PD-248 — surface GitHub rate-limit / API errors** | Unattended-operation safety. The core is one distinction: a **secondary rate limit** (403 + `Retry-After`) must back off, while an **auth failure** (401/403 invalid token) pauses the loop system-wide. Conflating them takes the whole loop down over a transient throttle. |
| 4 | **PD-310 — robots ask_human instead of guessing when they need docs** | Only the **instruct** half gates: tell the agent to raise an `ask_human` rather than guess when it needs a lookup. |

**PD-248 and PD-310 should both be trimmed, not built as written.** PD-248's Dev Ops rate-limit
readout is a follow-up; the fault-classification fix is the blocker. PD-310's domain allow/deny UI
(one-time / permanent, plus the safety-check agent) is a whole feature and is *not* a blocker — split
it. Note PD-310's body still says "Sortie agents" throughout and predates the Robot loop; re-read it
against `prompt.ts` before starting.

**Not blockers — 5.** Recommend dropping the `blocks` edge on each (`PD-383` already done):

- **PD-383 — Get rid of prioritized lane** — de-gated 2026-08-06, now `relates`. Steve still wants it
  soon (it helps him read the board), just not as a gate. Note three remaining blockers currently
  *sit* in the prioritized lane.
- **C-3 — agent-agent communication visibility** — Core project, mis-filed (above).
- **PD-162 — Activity Feed** — per-ticket timeline already ships; the remainder is observability, not
  loop safety.
- **PD-433 — Refine read-only board access via MCP** and **PD-435 — Refine updates existing tickets**
  — Refine is an **interactive** agent with a human in the loop. Nothing about its board access
  affects whether the **autonomous** Robot loop is safe to resume. Both are ticket-authoring quality.
  (PD-435 depends on PD-433; keep that edge.)

If those four edges are dropped, **the gate is 4 tickets, not 9.**

### Suggested order

1. **PD-410 — UI killswitch.** Smallest, and it is the safety net for everything after it. Do it first
   so the rest of the work is done with a stop button on screen.
2. **PD-306 — `/harness` + `/wrap-up` in the robot prompt.** Prompt-only; no schema, no UI. Raises the
   floor on every run that follows.
3. **PD-248 (trimmed) — rate-limit vs auth-fault classification.** Touches `faults.ts`, which is
   well-tested and where PD-470's session-limit branch already lives — read that first, the shape is
   the same problem solved once already.
4. **PD-310 (instruct half only) — ask_human for lookups.** Same file as PD-306; consider doing both
   in one pass if PD-306 goes smoothly.

Then **PD-468** itself: walk the go-live checklist, resume, and *watch* the first run.

**Do PD-391 — robot-* / agent-worker helpers in `pd-help` the same day you go live**, not before. It
is not a safety blocker, but `robot-logs` and `robot-refresh` are exactly what you will be typing by
hand all afternoon otherwise — and `robot-refresh` *is* the image-rebuild step from the go-live
checklist, which is the step that silently failed once already.

## Per-ticket landmines

### PD-410 — UI killswitch
The backend exists (C4/PD-345, `robot_state.dispatch_paused`, pause/resume routes at
`POST .../robot/pause|resume`). This is a UI ticket. `apps/web/src/routes/devops/api.ts` is the only
web file that mentions the pause today — there is no nav component. **A paused loop must be
unmistakable**, which is the whole point; a subtle badge repeats the problem the ticket describes.

### PD-306 / PD-310 — the robot prompt
`apps/agent-worker/src/jobs/robot/prompt.ts`. Step 0 (resume) and the hand-off steps are load-bearing
and heavily commented — read the whole file before inserting anything. Note the prompt already tells a
reworking Robot to read inline PR comments via `gh api`; that is deliberate (PD-394's out-of-scope
half) and should not be duplicated.

### PD-248 — rate limits
Read `apps/agent-worker/src/jobs/robot/faults.ts` first. It already classifies auth 401/403 as a
**system-wide** fault that pauses the loop, and PD-470 added a `wait` decision with a self-clearing
hold — a rate limit is much closer to the latter than the former. The ticket's own note that
`gh pr view` does not surface `x-ratelimit-*` headers is correct and is the real design problem;
a periodic `gh api rate_limit` probe is likely simpler than threading headers through every call site.

## Conventions that will bite you

- **`npm run verify` is the gate.** Baseline on `main` at `d3f3866`: **server 528 / web 196 /
  agent-worker 271**, exit 0, with **8** pre-existing svelte-check warnings across 3 files
  (`RunHistory`, both `IdeaEditModal`s), 0 errors. Baselines move as other sessions land work —
  re-measure on `main` before assuming you broke something.
- **A local full `verify` is not authoritative.** Other sessions' worktrees live under
  `.claude/worktrees/` inside this checkout, and their work-in-progress has broken local runs twice.
  CI runs a clean checkout; that is the authority.
- **A new "Unused CSS selector" warning means you left dead rules behind.** That is how every scss
  change in this project gets validated.
- **`apps/web/src/lib/nav-utils.ts` must stay free of `.svelte` imports.** `apps/web/vitest.config.ts`
  deliberately runs *without* the SvelteKit plugin, so a transitive `.svelte` import breaks the entire
  web suite. Anything a `.spec.ts` imports must not reach a `.svelte` file.
- **Styles are never inline.** Sibling `.scss` via `<style lang="scss" src="./X.scss">`, and use the
  design tokens in `apps/web/src/lib/styles/global.scss` rather than raw hex/px.
- **Svelte scopes styles per component**, so shared chrome (`.section-head`, `.sr-only`) is duplicated
  per file on purpose. That is not cleanup waiting to happen.
- **Markdown rendered via `innerHTML` is not sanitized** (`$lib/markdown.ts`). PD-448 tracks it.
  Current exposure is nil; do not widen it.

## Workflow gotchas

- **Check `origin/main` for the next free `D-NNN` immediately before committing**, not when you start
  writing. Two sessions minted D-065 simultaneously on 2026-08-05. `DECISIONS.md` is the one file that
  always conflicts — every session appends to the top.
- **Never `git add -A` in this repo.** Other sessions leave uncommitted work in the shared checkout;
  stage by explicit path every time. `git pull` will also refuse while their edits are live — branch
  from `origin/main` instead.
- **CI silently not running means your PR conflicts with main.** `pull_request`-triggered workflows do
  not queue when GitHub can't build `refs/pull/N/merge`, while `pull_request_target` ones (path-guard)
  still run. **path-guard running alone is the tell.**
- **Commit `MEMORY/` straight to main.** A memory commit on a feature branch was dropped by a squash
  merge on 2026-07-30 and a session later recorded a phantom "2.5 week gap". A squash merge is not a
  promise your last commit is included.
- **The agent-worker image is a build artifact.** Merging agent-worker code to `main` does not update
  the running container, and `docker-compose up -d` recreates from the **existing** image. The
  heartbeat `sha` will not tell you — it reports the worker's grounding checkout, which pulls on boot.
  The honest check is **`budget != null` on `/system-status`**.
- **git pushes as the wrong account.** The macOS keychain hands back `scolacurcio` (Splice) for this
  `scolacur` repo; the repo routes git through `gh` to fix it. A 403 on push is this.
- **You cannot approve your own PR** — your own PRs merge with `gh pr merge <n> --admin`. This is also
  why the auto-merge bridge can only ever be exercised by a **bot-authored** PR; see the runbook in
  `docs/robot.md`.
- **Do not apply `sensitive-change-approved` to your own PR.** It is a *human* ack. An agent
  self-approving reproduces the exact incident (#268) the guard exists to prevent.
- **Don't stack PRs.** Branch each ticket off a freshly-pulled `main`.
- **Mark the ticket `completed` on the board yourself after merging.** The loop will not: its PR-state
  poll only completes tickets **it** dispatched. A hand-built PR has no link to the ticket at all.
- NAS clock runs **UTC−5** while the Mac is EDT, so NAS timestamps read an hour behind.

## Board quick reference

Prod on the NAS is the **only** source of truth — local `:8080` serves seeded dummy data. There is no
by-id route; fetch the array and filter on `displayId`. Internal ids ≠ display ids.

```sh
# read one ticket's body
curl -s http://192.168.68.50:8088/api/widgets/task-monitor/tickets \
  | python3 -c "import sys,json;print([t for t in json.load(sys.stdin) if t['displayId']=='PD-410'][0]['body'])"

# mark completed after merging
curl -s -X PATCH http://192.168.68.50:8088/api/widgets/task-monitor/tickets/<id> \
  -H 'Content-Type: application/json' -d '{"status":"completed"}'

# relations — `from` is the BLOCKER, `to` is the blocked ticket.
# NOTE the asymmetry: GET returns `fromTicketId`/`toTicketId`, but POST wants `fromId`/`toId`.
# Sending the GET field names back is a 400.
curl -s -X POST http://192.168.68.50:8088/api/widgets/task-monitor/tickets/<id>/relations \
  -H 'Content-Type: application/json' -d '{"fromId":<blocker>,"toId":<blocked>,"type":"blocks"}'

# drop a relation (de-gating a ticket) — relation id comes from GET /relations
curl -s -X DELETE http://192.168.68.50:8088/api/widgets/task-monitor/tickets/<id>/relations/<relationId>

# clear a stuck agent_state so a queued ticket can actually dispatch
curl -s -X POST http://192.168.68.50:8088/api/widgets/task-monitor/tickets/<id>/robot/unstick
```

To recount the gate at any time:

```sh
python3 - <<'PY'
import json, urllib.request
B = "http://192.168.68.50:8088/api/widgets/task-monitor"
tix = {t['id']: t for t in json.load(urllib.request.urlopen(f"{B}/tickets"))}
rel = json.load(urllib.request.urlopen(f"{B}/relations"))
live = [tix[r['fromTicketId']] for r in rel
        if r['toTicketId'] == 557 and r['type'] == 'blocks'
        and tix.get(r['fromTicketId'], {}).get('status') not in ('completed', 'closed', 'archived')]
print(f"PD-468 live blockers: {len(live)}")
for t in sorted(live, key=lambda x: (x['priority'], x['displayId'])):
    print(' ', t['priority'], t['displayId'], '|', t['status'], '|', t['title'][:64])
PY
```
