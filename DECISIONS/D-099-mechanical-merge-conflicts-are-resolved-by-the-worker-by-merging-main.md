# D-099: Mechanical merge conflicts are resolved by the worker, by merging main in, and a resolved Robot PR is reviewed again

**Date:** 2026-11-20 · **Epic:** PD-418 (Robot loop hardening) · **Ticket:** PD-774 · **Related:** [[D-098]] (review-gate), [[D-047]] (sensitive paths), [[D-055]] (the Robot's PR-state poll), [[D-039]] (the coding uid is a separate, less-trusted principal)

## Context

Two kinds of conflicted PR sat waiting for a person. Hand-built session PRs and Steve's own sat until someone rebased them by hand; #430 (Refine auto-start, PD-747) was one, on 2026-11-19. Conflicted Robot PRs were re-queued for a full Robot run, even when the conflict was mechanical: two branches appending to the same export list, or the generated decision index. Once Robot PRs auto-merge (D-098), a conflict is also the most common reason a finished PR stops short of merging.

## Decision (shape agreed with Steve on 2026-11-20)

1. **The agent-worker resolves, from a poll.** It already polls PRs and holds a write token, npm and egress. Its push uses a PAT, so CI runs again; a GitHub Action pushing with GITHUB_TOKEN would not re-trigger CI and would leave stale checks. It covers every open same-repo PR into `main`, one per pass. It is off unless `CONFLICT_RESOLVER_ENABLED`.
2. **Merge main in, never rebase.** The branch's history is left alone and the push is a plain fast-forward, so a session still working on the branch just pulls. A branch that moved during the merge rejects the push, and the next pass retries on the new head. Squash merging means the merge commit never reaches main.
3. **An allow-list, and nothing else, is resolved:** generated files (`DECISIONS.md` and the decision seed module) are regenerated from the merged sources; append-only hunks (diff3 base empty, both sides added) keep both sides, main first. Any other conflicted file aborts the whole attempt with nothing pushed. A sensitive path is refused even when its shape qualifies, because changing one needs Steve's ack (D-047).
4. **Verify gates the push, and the PR's code runs dropped.** `npm ci`, the regenerate step and `npm run verify` execute the branch's own code, so they run as the Robot's uid with the allowlisted env (PD-777): no tokens, no DB. Only git runs as the worker, and the write token reaches git as a per-call header.
5. **A resolved Robot PR is reviewed again (Steve's choice over carrying the gate forward).** The resolution logs `robot_conflict_resolved`, which is a review boundary like a hand-off: the Evaluator reviews the new head with a fresh pair of rounds, and review-gate on the new head starts empty, so nothing auto-merges on the old verdict.
6. **Routing when it can't.** A Robot PR goes back to the Robot exactly as before (re-queued with a `conflict` reactivation). With the resolver on, the PR-state poll leaves conflicts to it, so they are not routed twice. Any other PR raises one notification for Steve. Each head is tried once to a final outcome. Transient errors are retried three times.

## Consequences

- A non-Robot PR Steve already approved keeps its approval across the resolver's push (`dismiss_stale_reviews` is off), so review-gate.yml re-posts success and the bridge can merge it once CI is green. That is today's semantics for any push to an approved PR.
- A resolution costs one clone plus a full `npm ci` and verify on the NAS, with no LLM.
