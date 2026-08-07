# D-042: Sortie review re-work moves from the native `reactions.review_comments` to an in-repo Actions bridge (PD-256)

**Decision:** Disable Sortie's native `reactions.review_comments` and drive PR-feedback re-work
from a new in-repo GitHub Actions workflow, `.github/workflows/sortie-review-rework.yml`. On a
trusted human review or comment on a `sortie/*` PR it flips the linked issue
`sortie:in-review` → `sortie:queued`; Sortie re-dispatches a normal run, `before_run` reuses the
existing branch, and the prompt's "check for an open PR" step (Step 2B) reads the feedback off the
PR and pushes fixes. Also bumped `agent.max_sessions` 3 → 5.

**Why:** The native reaction was silently dropping feedback. Root-caused live for PD-256: the
reaction only arms its watch-set at the process-startup "pending reaction recovery" pass — one per
container **restart**. An issue that hands off to `sortie:in-review` *between* restarts is never
watched, so a review/comment on its PR does nothing until the next restart. Proven on issue #132
(handed off 12m after a restart; a "Request changes" review 17h later did nothing; a manual restart
re-armed it and it immediately re-worked). Second defect: the native reaction only fired on a
`CHANGES_REQUESTED` review — never a plain PR comment or a "Comment" review — so most of the ways
feedback is actually left never triggered re-work. The bridge runs in GitHub Actions (not coupled
to container restarts) and broadens the trigger set to Request-changes, Comment reviews, inline
review comments, and top-level PR comments (a pure Approve is excluded).

**This reverses the D-016-era note** in the old README/WORKFLOW that a label flip was *worse* than
the native mechanism ("a flip would stop reactions by moving the issue out of `handoff_state`").
That reasoning only held while we depended on the native reaction; now that it's disabled, the
label flip is the mechanism — the same proven pattern as `sortie-conflict-rework.yml`.

**Loop safety:** only the repo OWNER (or a COLLABORATOR carrying the `<!-- sortie:human-reply -->`
marker) triggers it; the bot's own comments and the workflow's confirmation comment are excluded;
flipping out of `in-review` makes duplicate events no-ops; per-issue `max_sessions`/`max_tokens`
still cap re-work cycles.

**Alternatives rejected:** (a) keep the native reaction and just restart the container on a cadence
— fragile, and still change-requested-only; (b) run both native + bridge — risks double-dispatch if
the native poller wakes after a restart. Single source of truth is the bridge.

**Deploy:** the workflow is live only once merged to `main`; disabling the native reaction +
`max_sessions: 5` needs a container **recreate** (not restart), per README Step 4.7.
