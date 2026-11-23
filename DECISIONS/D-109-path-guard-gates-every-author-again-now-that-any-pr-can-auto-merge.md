# D-109: The path-guard gates every author again, Steve included, now that any PR can auto-merge

**Date:** 2026-11-22 · **Epic:** PD-911 (One PR pipeline) · **Ticket:** PD-912 (sensitive-change ack on Steve's PRs again) · **Supersedes:** [[D-067]] (path-guard author-scoped to exempt Steve) · **Related:** [[D-047]] (path-guard), [[D-101]] (Evaluator reviews every PR; `AUTO_MERGE_ALL`)

## Context

D-067 exempted Steve's PRs from the `sensitive-change-approved` ack. Its premise was that Steve merged his own PRs, so reviewing the diff and merging it was already the ack the label asked for. D-101 removed that premise. The Evaluator now reviews every PR, its ship opens `review-gate`, and with `AUTO_MERGE_ALL=on` the bridge merges the PR. A session PR touching `.github/**`, a dependency manifest or a schema could therefore merge with no human having looked at it.

## Decision (Steve, 2026-11-22)

1. **Every PR that touches `.github/sensitive-paths.txt` needs the `sensitive-change-approved` label, whoever opened it.** The `AUTHORS_EXEMPT` allowlist and the Robot-branch backstop that guarded it are removed from `path-guard.yml`. With no exemption, there is no identity check left to fool.
2. **The ack stays a manual step by Steve** on Robot PRs and session PRs alike. It is the one human gate left on the PR pipeline (PD-911): Evaluator → rework → Evaluator → auto-merge once it ships, checks pass and, for a sensitive diff, the label is applied.
3. **The denylist is unchanged.** This decides *who* is gated, not *what* is sensitive.

## Consequences

- The `**/schema.ts` false positives D-067 removed come back on Steve's widget PRs. The fix is PD-474 (path-guard false positives on schema.ts), which narrows *what* is sensitive. Re-exempting an author is ruled out, because any exempt PR can now auto-merge.
- `--admin` still bypasses the guard (`enforce_admins: false`). That is a deliberate human act, which is the trust model D-047 settled on.
