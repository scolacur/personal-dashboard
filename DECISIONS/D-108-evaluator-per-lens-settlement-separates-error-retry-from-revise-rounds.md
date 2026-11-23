# D-108: Evaluator per-lens settlement separates the one-error retry cap from the revise round cap

**Context:** PD-883 (defects #2/#3 of PD-853). The Evaluator's Robot path re-ran every lens on every
poll and `alreadyEvaluated` keyed off "any `code` row exists", so an errored `security` lens never got
a retry and a single errored `code` row marked the whole PR done. The fix adds a per-lens,
per-review-cycle state and a **one-retry-on-error** cap that must be independent of
`MAX_EVALUATION_ROUNDS` (the revise ping-pong limit).

**Decision:** `lensStates()` reduces a review unit's runs to per-lens `{verdictRuns, errorRuns,
hasTerminalVerdict}`, and one predicate `lensNeedsRun()` drives both `alreadyEvaluated` (idempotence)
and the set of lenses `evaluateOnePr` actually runs. A lens is **settled** (not re-run) when:

- it has a **terminal** verdict — `ship` or `escalate` (`hasTerminalVerdict`), OR
- it has used its one error retry — `errorRuns >= MAX_LENS_ERROR_RUNS` (2: original + retry), OR
- it has revised up to the round cap — `verdictRuns >= MAX_EVALUATION_ROUNDS`.

The two caps are deliberately counted off **different** columns: the error retry counts
**no-verdict** runs (`errorRuns`), the revise round counts **verdict-bearing** runs (`verdictRuns`).
An error retry therefore never consumes a legitimate revise round, and vice versa.

**The non-obvious part — a `revise` is NOT terminal.** PD-883's prose says "a lens that already has a
verdict this cycle" is done. Taken literally that would settle a lens on its first `revise`, which
removes the only path by which `MAX_EVALUATION_ROUNDS` is ever reached and so disables the revise
ping-pong cap. A `revise` is the verdict whose whole meaning is "come back after rework", so
`lensNeedsRun` treats a sub-cap `revise` as **still needing a run** while treating `ship`/`escalate`
as terminal. In production a `revise` reactivates the ticket out of `in-review`, so this only matters
to the direct-call tests that exercise the round cap — but keeping it preserves that cap instead of
silently dropping it.

Lenses already settled with a verdict are **folded** into the combined decision from the DB rather
than re-run, so a retried `security` ship combines with a prior `code` ship to open `review-gate`
(a settled lens must not read as a missing verdict). A lens that used its retry with no verdict folds
in as `null`, keeps the gate failing, and raises one `agent_needs_human` entry (notify's unread
dedup).

Cited in `apps/agent-worker/src/jobs/evaluate/evaluator-runs.ts` (`lensNeedsRun`, `lensStates`,
`alreadyEvaluated`) and `evaluate.ts` (`evaluateOnePr`).

**Alternatives considered:** a literal "any verdict → settled" predicate (rejected — disables the
revise round cap); folding the error-retry count into `evaluationRounds` (rejected — an error would
then burn a revise round, the exact coupling PD-883 forbids).
