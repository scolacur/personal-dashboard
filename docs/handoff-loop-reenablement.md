# Handoff — Robot loop re-enablement (PD-468) and the work in front of it

Written 2026-08-04 at the end of the session that shipped PD-413/414/415, PD-409, PD-308 and
PD-426. Read this **after** `/harness pd`, which loads PROJECT.md and the recent `MEMORY/` day
files. Delete or rewrite it once PD-468 is done.

Your priority is the **PD-468 blockers** and the **Queue lane**, in whatever order makes sense.
This document exists to stop you rediscovering what already cost a day to learn.

---

## The one thing to know first

**Robot dispatch is PAUSED and must stay paused until PD-468 says otherwise.** Steve's plan has a
lower token budget and the loop exhausted the session quota three times in two days. The reason is
recorded on the loop itself (`GET /api/widgets/task-monitor/system-status` → `dispatch`).

**Do this work by hand. Do not queue it to the robot** — the robot is what you are repairing.
Note your own session draws on the **same Claude account** as the robot and Refine, so budget
accordingly.

**PD-468** is the single gate ticket: "turn the loop back on". It is blocked by everything below.
**PD-469** (verify PD-426 against a real failing run) is blocked by PD-468 — it cannot start until
the loop is actually running.

---

## ⚠️ What changed today that will affect your very first PR

**The path-guard is LIVE and is a required status check** (PD-308, D-047 Tier 1). Any PR whose diff
touches a glob in `.github/sensitive-paths.txt` turns `path-guard` **red** and cannot merge without
a write+ collaborator applying the **`sensitive-change-approved`** label.

The list covers `.github/**`, `ops/**`, `docker/**`, `**/Dockerfile`, `**/docker-compose*.yml`,
`**/.env*`, `**/schema.ts`, `apps/server/src/migrate.ts`, `.claude/**`, `**/package.json`,
`package-lock.json`, and the forward-looking `**/auth/**`, `**/session/**`, `**/*cors*`, `**/*csp*`.

**Predict it before you push** — same matching the CI job uses:

```sh
SPECS=(); while IFS= read -r p; do [ -n "$p" ] && SPECS+=( ":(glob)$p" ); done \
  < <(sed -e 's/#.*//' -e 's/[[:space:]]*$//' .github/sensitive-paths.txt | grep -v '^$')
git diff --name-only main -- "${SPECS[@]}"   # any output ⇒ the guard will go red
```

**Do not apply the label to your own PR.** It is a *human* ack — an agent self-approving reproduces
the exact incident (PR #268) the guard exists to prevent. Ask Steve.

`enforce_admins` is false, so `gh pr merge --admin` still merges past a red guard. Steve used that
on #283. It works, but it leaves no record of the ack on the PR, so prefer the label.

**Adding any dependency is now a labelled PR** — `**/package.json` is on the list. Budget for that
before reaching for a new library.

---

## Where things stand

Shipped 2026-08-04 (all by hand, all merged):

| | |
|---|---|
| PD-413 / PD-414 / PD-415 (#274/#275/#276) | Dev Ops restructure — epic PD-382 now 7/8, only the deferred P4 PD-416 left |
| PD-409 (#277) | Ticket description renders markdown, with a Raw toggle |
| PD-308 (#279, #283) | **Path-guard live + wired as a required check** |
| PD-426 (#285) | Bounded 8 KB output tail captured onto the run row |

Filed today: **PD-444** (retire the widget flip, D-062), **PD-448** (sanitize rendered markdown),
**PD-467**, **PD-468**, **PD-469**, **PD-470**.

Closed today: **PD-411** (multi-plan failover) — superseded, see below.

Other sessions are working this board concurrently. PD-441 and PD-294 landed while this session was
mid-branch, and the board was reorganised into ~42 epics. **Re-read the board; do not trust a
remembered lane.** This session got the Queue wrong once by working from a four-day-old memory file.

---

## The gate: PD-468's blockers

18 edges, but **PD-426 is already completed** (a resolved blocker no longer gates), so 17 are live.

| Ticket | Pri | Ready | State | What |
|---|---|---|---|---|
| PD-162 | P1 | ✗ | prioritized | Activity Feed |
| PD-248 | P1 | ✓ | prioritized | Surface GitHub rate-limit headroom |
| PD-306 | P1 | ✗ | prioritized | Robot agents use `/harness [project]` |
| **PD-310** | P1 | ✗ | backlog | **Enable + instruct agents to `ask_human`** |
| PD-432 | P1 | ✓ | queue | Per-ticket `max_turns` + Refine estimates budget |
| **PD-470** | P1 | ✓ | backlog | **Reset-aware retry — a session-limit park expires itself** |
| C-3 | P2 | ✗ | backlog | Visibility into agent-agent communication |
| PD-383 | P2 | ✗ | backlog | Remove the `prioritized` lane |
| PD-391 | P2 | ✓ | backlog | `robot-*` helper commands in `pd-help` |
| PD-393 | P2 | ✓ | backlog | **Looks already done — verify and close (see below)** |
| PD-394 | P2 | ✓ | backlog | Rework poll misses inline PR review comments |
| PD-410 | P2 | ✓ | backlog | Nav-level dispatch killswitch |
| PD-424 | P2 | ✓ | backlog | Auto-merge bridge deadlocks on its own check |
| PD-433 | P2 | ✓ | backlog | Refine gets read-only board access via MCP |
| PD-435 | P2 | ✓ | backlog | Refine may update EXISTING tickets |
| PD-463 | P2 | ✓ | queue | Loop-wide budget ceiling |
| PD-467 | P2 | ✓ | backlog | Queued + `agent_state='stuck'` is silently undispatchable |

Deliberately **not** blockers, after review with Steve: PD-247 (spike), PD-378 (de-root the loop),
PD-385 (npm cache) — performance/exploration, not safety. **PD-419** (cheaper model access) is
linked `relates`, not `blocks`: it is an investigation, and the loop should not wait on a write-up.
**PD-312** (Guardrail Tier 2) is not a blocker either — D-047 is explicit that Tier 2 is early
feedback and UX, never the boundary. Tier 1 is the boundary and it is live.

---

## Suggested order, and why

**Tier 0 — free wins, do first.**

1. **PD-393** — verify and close. All three of its requirements appear implemented on the
   ticket-detail page, with code comments citing PD-393 by name: the `ask_human` question renders
   above the reply textarea (`askHumanQuestion`), `awaiting-human` is excluded from `isRobotParked`,
   and `stuck`/`needs-human` still get Reset/Unstick. The one thing not verified is the banner
   *copy* requirement. Check that, then close it — it removes a blocker for minutes of work.

**Tier 1 — make the loop's failures visible before you trust it again.** Turning the loop on
without these means a failure looks identical to an idle loop.

2. **PD-467** — a queued, robot-assigned, Ready, unblocked ticket can still never dispatch, because
   `select.ts` gates on `agent_state IS NULL OR 'queued'` and dragging a card back to the Queue does
   not clear a `stuck` state. **PD-426 was in exactly this state this morning.** Preferred fix is to
   clear a terminal `agent_state` on queue entry — remove the trap, don't just report it.
3. **PD-470** — a session-limit park currently outlives its cause. PD-420 parked at 21:45, quota
   reset at 1:30 AM, ticket sat idle ~12h with four tickets stranded behind it. With a single plan
   this is the *only* unattended recovery.
4. **PD-463** — the loop-wide budget ceiling. This is the structural fix for the exact thing that
   caused the pause. Turning the loop back on without it invites the same failure.
5. **PD-432** — per-ticket `max_turns`. P1, Ready, already in the Queue.

**Tier 2 — the loop's outward mechanics, which strand work when broken.**

6. **PD-424** — the auto-merge bridge reads its own in-flight check as `UNSTABLE` and skips, then
   nothing re-fires. Every robot PR needs hand-merging until this is fixed.
7. **PD-394** — the rework poll misses inline PR review comments, so review feedback silently fails
   to re-activate a ticket.
8. **PD-410** — nav-level killswitch. **Not already done**: the existing pause/resume toggle is the
   Site Status one (now on `/devops/agent-dashboard`), and this ticket exists *because* that is easy
   to miss. It wants an always-visible nav control.
9. **PD-391**, **PD-433**, **PD-435** — helper commands and Refine improvements. Mechanical, Ready.

**Tier 3 — needs shaping before it can be worked (all `ready=false`).**

10. **PD-310** is the important one here: P1, and behaviourally the core of the whole safety model —
    an agent that cannot `ask_human` guesses instead. **Shape it early** even if you build it late,
    because shaping needs Steve and a Refine session costs the same quota as everything else.
11. **PD-306**, **PD-162**, **PD-383**, **C-3**, and **PD-248** (Ready but steve-assigned).

---

## Per-ticket landmines

### PD-470 — reset-aware retry
- The error text carries the reset time verbatim: `You've hit your session limit · resets 5:30am (UTC)`.
  Parse **defensively** — an unparseable variant must degrade to a bounded retry, never an
  indefinite park.
- The real bug is the **promotion**: two identical session-limit signatures are one transient cause
  seen twice, but C2 promotes transient→deterministic at N=2 and parks. Stop that promotion for this
  fault class specifically; do not weaken the general rule.
- Distinct from PD-463: PD-463 is about *not spending*, PD-470 is about *recovering* after the
  provider says stop.

### PD-467 — the silently-undispatchable trap
- `robotQueueCandidates` in `apps/agent-worker/src/jobs/robot/select.ts` is the gate.
- Unstick is `resetRobotRuns(db, id, 'unstick')` — despite the name it does **not** delete
  `agent_runs` rows; it flips `agent_state` to `queued` and logs an audit event. Non-destructive.
- Whatever fix you choose, add the loop-side warn log. Silence is the actual defect.

### PD-426 follow-ups (do not fold into other work)
PD-426 deliberately deferred three things, all written up in its body: durable per-run forensics
under `/data`, relocating the coding transcript off the image, and reclassifying a budget-exhausted
`no-verify` as a *sizing* signal rather than an identical-failure promotion. **PD-469** verifies the
capture itself against a real run — the one assumption its unit tests had to make is the real SDK's
tool-result shape.

---

## Conventions that will bite you

- **`npm run verify` is the gate.** Baseline as of this handoff: **server 309 / web 166 /
  agent-worker 222**, exit 0, with **8** pre-existing svelte-check warnings (`RunHistory`,
  `IdeaEditModal`). Baselines move as other sessions land work — re-measure on `main` before
  assuming you broke something.
- **A new "Unused CSS selector" warning means you left dead rules behind.** That is how every scss
  change in this project gets validated.
- **`apps/web/src/lib/nav-utils.ts` must stay free of `.svelte` imports.** `apps/web/vitest.config.ts`
  deliberately runs *without* the SvelteKit plugin ("pure-TS unit tests"), so a transitive `.svelte`
  import breaks the entire web suite. This cost real time today. Anything a `.spec.ts` imports must
  not reach a `.svelte` file.
- **Styles are never inline.** Sibling `.scss` via `<style lang="scss" src="./X.scss">`, and use the
  design tokens in `apps/web/src/lib/styles/global.scss` rather than raw hex/px.
- **Svelte scopes styles per component**, so shared chrome (`.section-head`, `.sr-only`) is
  duplicated per file on purpose. That is not cleanup waiting to happen.
- **Markdown rendered via `innerHTML` is not sanitized** (`$lib/markdown.ts`). PD-448 tracks it.
  Current exposure is nil; do not widen it.

## Workflow gotchas

- **Commit `MEMORY/` straight to main.** On 2026-07-30 a memory commit landed on a feature branch at
  the same minute its PR was squash-merged; the squash dropped it, and the next session recorded a
  "~2.5 week gap" because the log was not on `main` to read. Recovered in `c0ef7e1`. **A squash merge
  is not a promise your last commit is included** — verify after merging.
- **git pushes as the wrong account.** The macOS keychain hands back `scolacurcio` (Splice) for this
  `scolacur` repo; the repo routes git through `gh` to fix it. A 403 on push is this.
- **You cannot approve your own PR** — merging needs `gh pr merge <n> --admin`.
- **Don't stack PRs.** Branch each ticket off a freshly-pulled `main`; a stacked PR merged into the
  wrong base lost a whole ticket's work on 07-09 (PD-338).
- **Mark the ticket `completed` on the board yourself after merging.** The loop will not: its
  PR-state poll only completes tickets **it** dispatched (`status='queue' AND assignee='robot' AND
  agent_state='in-review'`, with the PR found via the run's recorded `pr_url`). A hand-built PR has
  no link to the ticket at all.
- **The Mac's disk filled completely** during this session and broke tool calls mid-task. If commands
  start failing with `ENOSPC`, that is why — `df -h /`.
- NAS clock runs **UTC−5** while the Mac is EDT, so NAS timestamps read an hour behind.

## Board quick reference

Prod on the NAS is the **only** source of truth — local `:8080` serves seeded dummy data. There is
no by-id route; fetch the array and filter on `displayId`. Internal ids ≠ display ids.

```sh
# read one ticket's body
curl -s http://192.168.68.50:8088/api/widgets/task-monitor/tickets \
  | python3 -c "import sys,json;print([t for t in json.load(sys.stdin) if t['displayId']=='PD-470'][0]['body'])"

# mark completed after merging
curl -s -X PATCH http://192.168.68.50:8088/api/widgets/task-monitor/tickets/<id> \
  -H 'Content-Type: application/json' -d '{"status":"completed"}'

# relations — `from` is the BLOCKER, `to` is the blocked ticket
curl -s -X POST http://192.168.68.50:8088/api/widgets/task-monitor/tickets/<id>/relations \
  -H 'Content-Type: application/json' -d '{"fromId":<blocker>,"toId":<blocked>,"type":"blocks"}'

# clear a stuck agent_state so a queued ticket can actually dispatch
curl -s -X POST http://192.168.68.50:8088/api/widgets/task-monitor/tickets/<id>/robot/unstick
```
