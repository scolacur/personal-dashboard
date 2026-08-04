# Handoff — Dev Ops slices PD-414 / PD-415

Written 2026-07-30 at the end of the session that shipped PD-420/421/422; updated 2026-08-04 when
PD-413 landed. Read this **after** `/harness pd` (which loads PROJECT.md + the recent `MEMORY/`
day files). Delete or rewrite this file once the remaining two tickets land.

---

## The one thing to know first

**Robot dispatch is PAUSED and must stay paused.** Steve's plan has a lower token budget, and the
loop exhausted the session quota three times in two days. The pause reason is recorded on the loop
(`GET /api/widgets/task-monitor/system-status` → `dispatch.paused`).

**Do this work by hand, not by queueing it to the robot.** Also note *your own session draws on the
same Claude account* as the refine sessions and the robot — so does everything else. Budget
accordingly.

Re-enable only after the hardening work lands: **PD-411** (reset-aware retry), **PD-426**
(`no-verify` diagnosability), **PD-432** (per-ticket `max_turns`).

---

## Where things stand

The Dev Ops restructure (epic PD-382 / id 469) is 4 of 6 done:

| Ticket | State |
|---|---|
| PD-420 route rename → `/devops` | ✅ merged (#270) |
| PD-421 Kanban → `/devops/task-tracker` | ✅ merged (#271) |
| PD-422 subroutes + shell + drop `#site-status` | ✅ merged (#272) |
| nav/Jobs polish | ✅ merged (#273) |
| PD-413 overview grid + Agent Dashboard | ✅ merged (#274) |
| **PD-414** deploy/commit → top nav | ⬜ **next** |
| **PD-415** paged sliding side nav | ⬜ |
| PD-416 API endpoint rename | ⬜ deferred P4 |

The route tree is now:

```
/devops                     → Arrange-able 3-widget grid (Task Tracker / Jobs / Agent)
/devops/agent-dashboard     → SystemStatus: Robot fleet + dispatch + workers
/devops/jobs                → full Jobs view
/devops/task-tracker        → the full Kanban (~1103 lines)
/devops/tickets/[id]        → ticket detail
/devops/reports/ticket-audit/**
```

All nav children are real subroutes; **no hash anchors remain under Dev Ops** — don't reintroduce
one.

---

## Sequencing, and why

**Do PD-414 before PD-415.**

PD-422 *removed* the `#site-status` section but deliberately left `DeployStatus.svelte` and
`SystemStatus.svelte` in the repo, unmounted. PD-413 re-homed SystemStatus (→ Agent Dashboard);
**`DeployStatus` is still rendering nowhere**, so PD-414 is now the only remaining
regression-closer, while PD-415 is purely additive.

PR #273 is merged, so the `SideNav` conflict PD-415 used to be gated on is gone.

---

## Per-ticket notes

### PD-413 — overview widget grid + Agent Dashboard ✅ (#274)

What landed, since PD-414 touches the same `+layout.svelte` and PD-415 the same nav model:

- **`canArrange` moved.** The old blanket `startsWith('/devops') → false` guard is gone. The route
  half now lives in `lib/nav-utils.ts` as `arrangeablePageId(pathname)` — an **exact** route match,
  unit-tested in `nav-utils.spec.ts` — and `+layout.svelte` pairs it with the widget count. Keep
  `nav-utils.ts` free of `widgets.ts` imports: the web vitest config runs **without** the Svelte
  plugin, so a transitive `.svelte` import breaks the whole suite.
- **Widget card headers are links** to the widget's page, replacing the old bottom-left
  "Expand ↗". The ↺ flip is now gated behind `embed.flippable`. Steve prefers this shape and wants
  the remaining widgets converted — **PD-444** tracks retiring the 3D flip entirely.
- **The registry gained `system: true` + `homeWidgets()`.** Home renders the whole registry, so
  anything added without that flag also appears on Home.
- **The Sortie line stayed.** The ticket called the `activeStates` block "the Sortie line", but C7
  relabelled it **Robot** and `getSortieFleet` aggregates live `agent_tickets.agent_state` —
  `sortie` is only a stale wire-field name. Deleting it would have dropped the Robot fleet counts.
  Decided with Steve; don't "finish the job" by removing it later.
- **A known non-bug:** widgets flash at default size before snapping to their stored span. That is
  `vite dev` only — SSR renders defaults, then hydration corrects. Prod is a static SPA shell
  (`adapter-static`, `fallback: index.html`) so the first paint is already client-side and correct.
  PROJECT.md §2 says "SSR off" but nothing declares it; a root `+layout.ts` with
  `export const ssr = false` would make dev match prod. Not done — out of scope, no ticket yet.

### PD-414 — deploy/commit into the top nav

- Render `DeployStatus` in `.top-nav` in `apps/web/src/routes/+layout.svelte`, **only** on
  `/devops` routes (`pathname === '/devops' || pathname.startsWith('/devops/')`).
- The top nav already conditionally renders the DEV badge, NotificationBell, theme toggle and
  Arrange button, so there's an established pattern to follow.
- `DeployStatus.svelte` lives at `apps/web/src/routes/DeployStatus.svelte` (note: **not** under
  `devops/`).
- The `startsWith` above is **correct here** and deliberately unlike `canArrange`'s exact match:
  deploy/commit shows on *every* Dev Ops route, whereas Arrange applies only to the one route that
  is actually a widget grid. Don't unify them.

### PD-415 — paged sliding side nav

- `lib/SideNav.svelte` currently uses an **accordion**: a parent with `children` reveals a
  `slide`-transitioned sublist in place. Replace with a two-level paged drill-down, general to any
  parent with children.
- The same component serves **both** the desktop rail (`.sidebar`) and the mobile drawer — one
  change covers both, so test both.
- PR #273 moved the active highlight from `.side-link` onto `.side-link-row.active` so it spans the
  caret, and gave the caret `--on-accent` for contrast on the yellow. **Preserve that behaviour**
  through the rewrite — it was a specific ask from Steve.

---

## Conventions that bit us this session

- **Styles never inline.** PROJECT.md §5: each `.svelte` gets a sibling `.scss` via
  `<style lang="scss" src="./X.scss">`. The Jobs page violated this and was fixed in #273.
- **Use design tokens**, don't hard-code hex/px. `--status-warn` was added to `global.scss` in
  PD-230 because it had been referenced with an inline fallback and never declared.
- **Svelte scopes styles per component**, so shared chrome (`.section-head`, `.section-title`) is
  duplicated in each page's scss on purpose. That's not an accident to clean up.
- **`npm run verify` is the gate** (typecheck + lint + build + all three test suites). Baseline is
  server 309 / web 115 / agent-worker 195, exit 0, with 8 pre-existing svelte-check warnings
  (`RunHistory`, `IdeaEditModal`). **A new "Unused CSS selector" warning means you left dead rules
  behind** — that's how the scss splits were validated.

## Workflow gotchas

- **git pushes as the wrong account.** The macOS keychain hands back `scolacurcio` (Splice) for
  this `scolacur` repo. Fixed repo-locally by routing git through `gh`; if you hit a 403 on push,
  that's why.
- **You cannot approve your own PR** — merging self-authored work needs `gh pr merge --admin`.
- **The auto-merge bridge is broken for approve-after-CI-green** (PD-424): it reads its own
  in-flight check as `UNSTABLE` and skips, then nothing re-fires. Merge by hand.
- **Don't stack PRs.** Branch each ticket off a freshly-pulled `main`; a stacked PR merged into the
  wrong base lost a whole ticket's work on 07-09 (PD-338).
- Mark the ticket `completed` on the board after merging — the loop won't, since it's paused.

## Board quick reference

```sh
# read
curl -s http://192.168.68.50:8088/api/widgets/task-monitor/tickets \
  | python3 -c "import sys,json;print([t for t in json.load(sys.stdin) if t['displayId']=='PD-413'][0]['body'])"

# write (PATCH/POST work fine; curl and python urllib both OK)
curl -s -X PATCH http://192.168.68.50:8088/api/widgets/task-monitor/tickets/<id> \
  -H 'Content-Type: application/json' -d '{"status":"completed"}'
```

Prod is the **only** source of truth — local `:8080` serves dummy dev data. Internal ids ≠ display
ids (PD-413 is id 501); filter on `displayId`.
