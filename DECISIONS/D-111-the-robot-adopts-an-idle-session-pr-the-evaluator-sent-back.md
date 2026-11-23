# D-111: The Robot adopts an idle session PR the Evaluator sent back, and reworks it on Steve's branch

**Date:** 2026-11-23 · **Epic:** PD-911 (One PR pipeline) · **Ticket:** PD-913 (Robot reworks an idle session PR) · **Amends:** [[D-101]] point 1 ("Robot PRs keep their own path") · **Related:** [[D-055]] (PR-state trust rules), [[D-083]] (terminal is final), [[D-091]] (refined to enter the Queue), [[D-109]] (path-guard gates every author)

## Context

After D-101, every PR is reviewed, but only a Robot PR is reworked when the Evaluator revises it. A session PR got a comment and waited for Steve. Steve wants one pipeline once a PR is open: Evaluator, rework, Evaluator, auto-merge. The only manual step left is the sensitive-path ack.

## Decision (Steve, 2026-11-23)

1. **Trigger: automatic after idle.** A session PR (not `robot/*`) is adopted when the Evaluator's review of its current head is a `revise` below the round cap and it has had no push for `EVALUATOR_ADOPT_IDLE_MS` (default 30 minutes) since that review finished. A push is a new head with a new review, so it restarts the clock. `EVALUATOR_ADOPT=0` turns adoption off.
2. **Hand-off, not a second rework path.** Adoption assigns the PR's branch ticket to the Robot (queued) and records `robot_adopted` with the PR number, branch and head. From then on it is an ordinary Robot rework. The dispatch picks it up by priority, the Evaluator's findings are its brief, it pushes to **Steve's branch** (the adoption's branch replaces `robot/t<id>`), and after hand-off it is an in-review Robot target with Robot-path reviews, statuses and complete-on-merge.
3. **No branch ticket, no adoption.** Only the ticket the branch names (`pd-NNN-…`) is adopted, and only when the dispatch would take it: refined, ready, robot-enabled project, not blocked, not terminal, and not already held by the Robot. Anything else gets PD-914's needs-human instead.
4. **Steve's push wins.** If he pushes or closes the PR before the Robot starts, the adoption is released: the ticket goes back to him (`robot_released`, needs-human). Once the Robot has started, PD-926's in-flight check stops the run when someone else pushes to the PR, and the adoption goes back to him rather than to in-review. Adoption logs a `robot_reactivated` naming the PR so both PD-924 and PD-926 recognise it, with a reason that never matches PD-924's "back to in-review" case. Between those checks, the prompt forbids force-push, rebase and amend, and tells the Robot to park with `ask_human` if its push is rejected.
5. **Everything else treats an adopted PR as the Robot's.** The session-PR review path and the conflict resolver skip it while the Robot holds it.

## Consequences

- The Robot now pushes to branches a human opened. Branch protection covers only `main`. PD-926 catches Steve's pushes within its check interval (2 min), and the prompt is the guard against the Robot force-pushing, the same trust it already gets on its own branches.
- Round counting: the session path's rounds and the Robot path's rounds (counted from the hand-off) are separate. An adopted PR can therefore be reviewed up to 2 × the cap in total, though never more than the cap per cycle.
- Adoption skips the Queue's Epic arming: it is rework of an existing PR, not new work. The loop pause, holds, circuit breaker and Robot budget still apply at dispatch.
