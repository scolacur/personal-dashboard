# D-122: The Ticket Audit's verify stage is one pooled, fail-open, drop/downgrade-only pass over deferred findings

**Status:** accepted (PD-839, slice 2/3 of PD-284)

## Context

The Ticket Audit (D-045) fans out one read-only agent turn per project (PD-284 slice 1),
each producing advisory findings with a `confidence`. Slice 2 adds an **adversarial verify
stage** (D-045): a second agent that challenges the fan-out's findings against their cited
evidence so a human spends attention only on findings that survive a skeptical second look.
Several shaping choices were not pinned down by the ticket.

## Decision

1. **One pooled verify turn, not per-project.** The verify stage runs exactly once per run,
   over every project's non-`keep` candidates together (Done-When #4). Pooling keeps the cost
   to a single turn regardless of how many projects the fan-out visited, and lets the verifier
   see the whole run's candidate set at once.

2. **Persistence is deferred to after verify.** `auditOneProject` no longer writes findings
   inline — it resolves them (including PD-285 carry-forward decisions and PD-828 relation
   findings) and returns them as in-memory `PendingFinding`s. `runAuditPass` pools them, runs
   verify, and persists **survivors only**. A dropped finding is therefore never written, which
   is how "verify never resurrects a dropped finding" is satisfied structurally rather than by a
   guard. Reconciliation still computes per-project decisions on the pre-verify set; dropping a
   finding never changes another finding's decision, because `reconcileDecisions` keys each one
   independently on `(ticket_id, type)`.

3. **The verify agent can only remove or weaken, never strengthen or invent.** A verdict is
   `uphold` / `downgrade` / `drop`. `downgrade` may only *lower* a finding's confidence
   (a raise or an invalid value is ignored); `drop` removes it. A candidate the verifier is
   silent about is upheld as-is. The verifier references candidates by integer index, so it
   cannot introduce a finding about a ticket, type, or target the fan-out did not propose.
   `keep` findings skip verify entirely — there is nothing adversarial to check about "no action
   needed," and sending them would waste the verifier's attention.

4. **Fail-open.** If the verify turn errors, times out, or returns `ok: false`, every candidate
   is kept as-is. The verify stage is a *precision filter on an advisory signal*; losing the
   whole fan-out's output because the second agent hiccupped is worse than occasionally showing a
   finding that would have been dropped. A human still reviews everything downstream.

5. **One runner seam, reused.** The verify turn uses the same injectable runner shape as the
   fan-out (a read-only Agent SDK turn with a system + user prompt); `deps.runVerify` defaults to
   `deps.runAgent`. This keeps the unit-test seam singular and means a test that stubs the fan-out
   controls verify too unless it overrides `runVerify`.

## Also in this slice

Per-run token/cost metadata: each agent turn's result-message `usage` + `total_cost_usd` is
captured and summed across the fan-out turns plus the verify turn, then written to new
`audit_run` columns (`input_tokens` / `output_tokens` / `total_tokens` / `cost_usd`) on finish.
`cost_usd` is the SDK's Claude-priced figure; it may be wrong for a non-Claude model, which the
ticket's Out-of-scope note accepts deliberately (no per-model price table in this slice).

## Consequences

- The run's `counts` (and per-bucket tallies) reflect **post-verify survivors**, not the
  fan-out's raw candidate count.
- A pre-migration DB (worker ahead of the schema change) still closes the run: the cost columns
  are written by a separate, column-guarded statement (`recordAuditRunCost`), mirroring how
  PD-910's `turns`/`tokens` are handled.
