# D-027: Base PRs on `main`, not on another open PR's branch — stacking silently opts out of CI + branch protection

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
