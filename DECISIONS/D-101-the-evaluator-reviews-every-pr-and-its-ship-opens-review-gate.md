# D-101: The Evaluator reviews every PR, and a ship from every lens opens review-gate as Steve's approval does

**Date:** 2026-11-20 · **Epic:** PD-506 · **Ticket:** PD-712 · **Amends:** [[D-076]] (Evaluator outputs go only to the DB), [[D-098]] (review-gate on non-Robot PRs comes from Steve's approval) · **Related:** [[D-047]] (path-guard), [[D-055]] (PR-state trust rules)

## Context

The Evaluator reviewed only Robot hand-offs, but a large share of what merges is built in sessions with Steve, and those PRs got no review at all. After the auto-merge cutover (D-098), session PRs had a second problem: they are opened under Steve's GitHub account, GitHub does not let an author approve his own PR, and review-gate on non-Robot PRs came only from his approval. So the gate could never go green, and every session PR was merged by admin override.

## Decision (agreed with Steve on 2026-11-20)

1. **Every open same-repo PR into `main` is reviewed**, discovered from the GitHub read API, one per Evaluator pass, after the Robot targets. Robot PRs keep their own path unchanged (rework through `ResumeContext`). A review is per head commit, so a new push is a new review, capped at the same two rounds per PR.
2. **What it judges against:** the ticket whose display id is in the branch (`pd-705-…`), title or body. With none, the PR description, and the review says it had no acceptance criteria.
3. **Skips:** drafts, forks, PRs whose files are all under `MEMORY/`, and the `skip-evaluator` label.
4. **Verdict goes to a PR comment and the ticket timeline.** This amends D-076's "no GitHub write" for non-Robot PRs only: there is no Robot to send a rework to, and the person fixing a session PR reads the PR. The comment comes from the bot account, which the PR-state poll never trusts (a COLLABORATOR without `HUMAN_REPLY_MARKER`), and the marker is stripped from anything the comment quotes, so a review can never trigger Robot rework.
5. **review-gate: a ship from every lens OR Steve's approval.** The worker posts success on a ship, on the exact commit it read; a head that moved before the diff was read drops the review. It posts nothing on revise or on a failed review, so it can open the gate but never close one Steve opened. `review-gate.yml` no longer resets an Evaluator success to pending when a review event arrives without an approval.
6. **Auto-merge of non-Robot PRs is a separate switch, `AUTO_MERGE_ALL`**, off unless exactly `on`, so session PRs can be held for Steve while Robot PRs flow. Path-guard still holds every sensitive-path PR for his ack.

## Consequences

- Evaluator spend roughly doubles. It stays on its own ledger and ceiling (`EVALUATOR_BUDGET_*`), and `EVALUATOR_ALL_PRS=0` turns this path off.
- A session PR the Evaluator ships can now merge without Steve, once `AUTO_MERGE_ALL=on`. Until then he merges it, now without an admin override.
