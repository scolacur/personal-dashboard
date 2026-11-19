# D-098: Robot PRs are gated by a `review-gate` status the Evaluator sets with a statuses-only token the Robot never holds

**Date:** 2026-11-19 · **Epic:** PD-762 ([Epic] Auto-merge Robot PRs once checks pass and the Evaluator ships) · **Ticket:** PD-763 · **Amends:** [[D-076]] ("a reviewer, never a merge gate") · **Related:** [[D-047]] / [[D-067]] (the path-guard), [[D-039]] (the coding uid is a separate, less-trusted principal)

## Context

D-076 made the Evaluator advisory on purpose: it had no track record, and "a second merge blocker with no track record is how a loop deadlocks". Steve now wants Robot PRs to merge, and therefore deploy, without him, once they pass checks **and** the Evaluator approves (decided 2026-11-18). Branch protection on `main` requires one approving review, which a Robot cannot give itself. So something must replace Steve's approval as the thing GitHub enforces, and the Evaluator's verdict is what the auto-merge bar names.

## Decision

1. **One required status, `review-gate`, means "this PR's review requirement is met".** On a Robot PR the agent-worker posts it from the Evaluator's verdict on the exact commit it reviewed: `ship` → success; a `revise` that sends the PR back → pending; a `revise` at the round cap, an `escalate`, or an evaluation with no usable verdict → failure ("needs Steve"). On every other PR a workflow posts it from Steve's approval (PD-764). Branch protection requires `verify` + `path-guard` + `review-gate` and drops the approval count (PD-766, by Steve).

2. **The token is the security boundary.** `REVIEW_GATE_TOKEN` is a fine-grained PAT with Commit statuses: write and nothing else. It lives only in the worker process and is stripped from the Robot's coding session. That matters here because `codingEnv` copies the worker's environment into the session; without the explicit strip, the Robot could post its own `review-gate`. The Robot's own token has no statuses permission. So the Robot can neither approve nor merge its own work.

3. **Pinned to the reviewed commit.** The head SHA is read before the diff. A push mid-review leaves the verdict on the commit that was reviewed and the new commit with no gate, so stale approval can't carry forward.

4. **Failure is never success** (unchanged from D-076). An evaluation that produced nothing usable fails the gate rather than passing or skipping it.

## Why this amendment is acceptable now

D-076 named its own trigger: "Revisit if the Evaluator's verdicts prove reliable enough to gate on." The reliability concern is met by containment, not by the Evaluator becoming infallible:
- the path-guard still requires Steve's ack on every sensitive change
- `escalate` and the round cap route to Steve
- a security evaluator joins before any auto-merge (PD-767)
- a kill switch stops auto-merge instantly (PD-765)

The deadlock concern is met because a failed gate never blocks *Steve*. He can still merge by hand as admin, and a `failure` says "needs Steve" rather than holding the PR for a loop that will never come.

## Consequences

- Nothing changes until PD-766's branch-protection cutover. Until then `review-gate` is an informational status.
- **Follow-up worth doing:** `codingEnv` is a denylist over the worker's environment. Every future worker-only secret must remember to strip itself, and the first one that forgets reaches the Robot. An allowlist (pass only what the session needs) is safer.
