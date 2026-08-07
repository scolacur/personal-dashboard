# D-064: The loop-wide budget ceiling counts turns per rolling 24h, and pauses deliberately

**Decision:** The Robot loop enforces a cumulative spend ceiling over a **rolling window**
(`ROBOT_BUDGET_WINDOW_MS`, default 24h), with two independent limbs: **turns**
(`ROBOT_BUDGET_TURNS`, default **500**) and **tokens** (`ROBOT_BUDGET_TOKENS`, default **0 =
off**). Evaluated per candidate at dispatch selection; a breach pauses via the existing
`robot_state.dispatch_paused` and raises a ticket-less Notification Center entry. Shipped in PD-463.

**Reasoning:**

- **Turns is the limb that ships on by default because it is the one already reasoned about.**
  `ROBOT_MAX_TURNS` is 50, so 500 is ten full-sized tickets a day — comfortably above a normal day,
  low enough that a runaway loop stops the same day it starts. Tokens are the honest measure of
  spend, but tokens-per-turn swings by model, so a default number would quietly go wrong after a
  model change; it stays opt-in.
- **One pause concept, not two.** A breach reuses `dispatch_paused` rather than adding a second halt
  path, so the existing resume control (and PD-410's killswitch) clears it. A second halt mechanism
  would mean two things to check when the loop is idle.
- **The ceiling gates new dispatch only; it never interrupts a run.** A Robot killed mid-hand-off
  loses the work outright ([[D-046]] — the hand-off runs in-turn because a context-cancel races it).
  So a breach detected while a Robot is in flight lets that Robot finish and stops the cycle after it.
- **Resuming is deliberate.** The pause is sticky: the window rolling over does not clear it, so
  spend cannot quietly re-arm the same burn overnight. A human resumes when they mean to.
- **In-flight spend counts.** The window sums `COALESCE(finished_at, started_at)`, so a long
  in-flight run's live turn count (PD-230) is counted as it is spent. Spend the ceiling cannot see
  is exactly what it exists to catch.
