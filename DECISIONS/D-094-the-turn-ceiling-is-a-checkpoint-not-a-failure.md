# D-094: The turn ceiling is a checkpoint, not a failure: report, save the work, and let Steve choose Continue or Restart

**Date:** 2026-11-16
**Tickets:** PD-737 (The turn ceiling is a checkpoint), PD-738 (Status pill opens a "needs you" modal) and PD-736 (Keep a run's work when it ends without a hand-off) under PD-609 (Robot loop hardening v2.5) · **Amends:** [[D-066]] (a ticket may raise its own turn ceiling) · **Related:** [[D-046]] (the hand-off-earned gate), [[D-055]] (fault tiers, park + surface), PD-340 (pristine tree every run)

## Context

On 2026-11-16, PD-721 (the Habit Tracker tracer) ran twice to the 50-turn ceiling. Both runs reached a
passing typecheck with two lint errors left. Both were classified as faults, and the second was
parked "max-turns on an unchanged body". Both clones were deleted, because each run uses a fresh
clone removed in a `finally` and nothing is pushed. The only remedy was to raise `maxTurns` and pay
for the whole build a third time.

Steve's diagnosis: hitting the ceiling is not the same kind of event as a crash. It usually means
"not finished yet", and the person deciding what to do next has no information. The run history
holds an output tail, not a status.

## Decision

1. **Reaching the turn ceiling ends a run as a checkpoint, not a fault.** It does not count against
   the retry cap and does not go through fault tiers.
2. **The loop gets a status report.** When the session stops at the ceiling, the loop resumes the
   same session briefly (a few turns) with one instruction: stop working; report what is done, what
   is left, what is blocking, and how many more turns it needs. If that step fails, the captured
   output tail stands in for the report.
3. **The work is saved** to the run's WIP ref (PD-736) before the clone is removed.
4. **The ticket parks in a new agent state, `checkpoint`**, which needs Steve's decision. Two
   actions:
   - **Continue (+N turns)**, default **+50**, editable up to the D-066 bound of 200 per run. It
     dispatches a new run that starts **from the saved work**, rebased onto current `main`, with the
     report in its prompt.
   - **Restart.** It dispatches a new run from a clean `main`, the PD-340 default, without the
     report. The saved work is kept until the ticket completes, in case it's wanted.
   > **Amended by [[D-114]] (PD-964, Checkpoint auto-continues a progressing run), 2026-11-24:** the
   > checkpoint is now a progress check every `CHECKPOINT_WINDOW_TURNS` turns. A progressing run
   > continues on its own; only a stalled, drifting or hallucinating one (or one at the total cap)
   > parks here. Continue no longer takes "+N turns": it starts a fresh episode.
5. **There is no total cap across Continues.** A human presses the button every time, and the run
   history shows the running total of turns, which is the information that judgement needs.
   > **Amended by [[D-114]], 2026-11-24:** reversed. There is a total cap of `CHECKPOINT_TOTAL_TURNS`
   > (default 200) per episode, because a human no longer presses every Continue.
6. **Only the ceiling gets this treatment.** Crashes, stalls and other faults keep their existing
   retry-then-park behaviour ([[D-055]]). A crashed session usually cannot report, and the existing
   logic for those cases works.

## Why

- **The two outcomes need different responses, and only a human can tell them apart:** "nearly done,
  give it room" and "it is going in circles". A status report is the cheapest thing that makes that
  call possible. Silently raising the ceiling would hide the second case.
- **Throwing away nearly-finished work is the most expensive possible response to "not finished".**
  PD-721 paid for the same build three times.
- **Resume is human-chosen, not automatic.** PD-340's rule that every run starts from a clean tree
  exists so that a broken tree cannot poison every retry. Continue breaks that rule deliberately and
  only on request; Restart keeps it.

## Alternatives rejected

- **The agent reports on its own before the ceiling** (the prompt says "at turn 45, write a status").
  Agents do not reliably track their own turn count, and the ceiling is a hard stop, so a missed
  self-report leaves nothing. The loop-driven follow-up works whatever the agent was doing.
- **Automatic resume from the WIP on retry.** It removes the human decision that is the point of the
  change, and it re-poisons retries with a broken tree.
  > **Superseded by [[D-114]], 2026-11-24,** for a progressing run (it continues the same session) and
  > for a transient-fault retry (it resumes that run's own saved work).
- **Simply raising the default ceiling.** It moves the cliff without giving any information when the
  run goes off it, and it is the outcome [[D-066]] warns against. Decomposing oversized tickets is
  still preferred.
- **A total cap across Continues.** Steve rejected it: every Continue is already a human decision.

## Consequences

- [[D-066]]'s per-ticket `max_turns` now means **turns per run before a checkpoint**, not a hard
  failure line. The 200 bound still applies per run.
- PD-736's open resume question is answered: resume happens only through Continue.
- PD-738 (the status-pill modal) gives `checkpoint` its Continue and Restart buttons, beside the other
  states that need input.
