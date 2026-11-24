# D-114: A checkpoint is a progress check: a run that is making progress continues on its own, and only a stalled one waits for Steve

**Date:** 2026-11-24 · **Epic:** PD-609 (Robot loop hardening v2.5) · **Ticket:** PD-964 (Checkpoint auto-continues a progressing run) · **Amends:** [[D-094]] (the turn ceiling is a checkpoint) §4, §5 and its rejection of automatic resume; [[D-066]] (a ticket may raise its own turn ceiling) · **Related:** [[D-064]] (the loop-wide budget ceiling), [[D-055]] (fault tiers), [[D-104]] (graceful stop), [[D-068]] (no sub-agents) · **Follow-up:** PD-967 (Remove the max-turns concept everywhere)

## Context

D-094 parked **every** run that reached its turn ceiling and waited for Steve to press Continue. That
is not what Steve meant by a checkpoint. A checkpoint should be a progress check: a run that is
making progress keeps going, and only a run that has stalled is stopped for a human.

On 2026-11-23, PD-931 (propose_commit gains a `supersedes` field) hit 51/50 turns at 16:00 EST. Its
report said "Blocking: nothing", with an estimate of 2–3 more turns. It sat in `checkpoint` for 7.5
hours, and the five PD-742 (Async Refine) tickets it blocks waited behind it.

The same ticket showed a second defect. Steve pressed Continue, and the run dispatched at 23:40. A
worker SIGTERM at 23:46 interrupted it as a transient fault. The retry got default turns and no
report, and it **rebuilt the change from scratch**: a Continue was consumed by the first dispatch
after it, so the retry saw no decision.

## Decision

1. **The check runs every window, not only at the ceiling.** Every `CHECKPOINT_WINDOW_TURNS` turns
   (default 25) the loop judges the last window. A run that is on track gets one more window. A run
   that is not stops, gives its status report as in D-094 §2, saves its WIP and parks in
   `checkpoint` for Continue or Restart. A looping run stops after at most one window.
2. **Each window resumes the same session.** A window that passes is continued with
   `resume: sessionId` and a short "keep going" prompt, so the run keeps everything it knew. This is
   the same mechanism the status report already used.
3. **Hard signals first, then a separate judge. The run never grades itself.**
   - **Tripwires** (deterministic; any one parks at once): the same tool call with the same input
     **and the same result** `CHECKPOINT_REPEAT_LIMIT` times (default 4) in the window (re-running
     verify after each fix is the same input with new output, which is progress, not a loop); the same error that many times; no
     change to the working tree across the window; verify failing the same way in two consecutive
     windows.
   - **Judge**, only if no tripwire fires: a separate model call with **no tools** and one turn. It
     sees the ticket, the run's plan (its latest TodoWrite), the window's diff and the window's
     transcript, held to a character budget from the end. It answers `progressing`, `stalled`,
     `drifted` or `hallucinating` with a one-line reason. Only `progressing` continues. A malformed
     answer, a failed call or a timeout parks.
   - Every check writes a `robot_progress_check` event (verdict, what decided it, reason, window,
     turns so far). The run history shows each one, and the checkpoint card says why the run parked.
   - The judge's turns and tokens are added to the run's usage, so they count against [[D-064]].
4. **There is a total cap per episode: `CHECKPOINT_TOTAL_TURNS` (default 200, the old D-066
   bound).** A run still progressing at the cap parks anyway, and the report says the cap stopped
   it, not the judge. An **episode** is the stretch since a human last pointed the Robot at the
   ticket: Continue, Restart, Reset, Unstick, an answered ask_human, or a rework reactivation.
5. **A human Continue starts a fresh episode and takes no turn count.** The "+N turns" picker is
   gone: the progress check and the cap decide the length, and a Continue past the cap still works
   because it begins a new episode. Restart is unchanged.
6. **A transient-fault retry resumes its run.** The loop's own retry of a run cut short by a
   transient fault (an interrupt, a network flake) is not a new episode. It restores **that run's**
   WIP, but only if that run saved one, so a ref from before a Restart can never come back on its
   own. It carries the episode's Continue report (or the interrupted run's output tail), keeps the
   episode's turns so far, and finishes the window it was cut short in.
7. **The per-run turn ceiling no longer bounds a run.** A ticket's `max_turns` and
   `ROBOT_MAX_TURNS` are not read by the loop. The run row's `max_turns` now records where its
   current window ends. Steve chose to remove the max-turns concept entirely; PD-967 removes the rest.

## Why

- **Most ceiling hits are "not finished yet".** A human pressing Continue on a run that reports
  "Blocking: nothing" adds hours of latency and no judgement. The check keeps the human for the case
  that needs one: the run that is going in circles.
- **A window catches a loop sooner than a ceiling.** A run that loops from turn 5 is stopped at turn
  25, not 50.
- **Generation ≠ evaluation.** The run's own report is a claim. A separate judge that sees only what
  the loop observed, with no tools, can't be talked into "progressing" by the run. The tripwires go
  first because they are cheap and cannot be argued with.
- **A judge that cannot answer has not shown progress.** Every failure mode parks. A wrong park
  costs one Continue click; a wrong continue costs up to a window of turns, and repeated wrong
  continues are bounded by the cap.
- **A retry is the same attempt, not a new one.** A worker restart says nothing about the ticket.
  Starting over throws away the very work D-094 set out to keep, and it spent the PD-931 Continue on
  rebuilding what was already built.

## Alternatives rejected

- **Let the run report whether it is on track.** It grades its own work, the failure D-094 already
  rejected for self-tracking.
- **Judge only at the ceiling.** A looping run would still burn the whole ceiling before anyone
  looked.
- **Keep Continue's +N picker as a hard allowance.** It would park a progressing continued run at an
  arbitrary number, which is the problem this decision exists to fix.
- **Restore the WIP ref on every retry.** After a Restart the ref may hold the pre-Restart work. Only
  a run's own saved work is restored.

## Consequences

- [[D-094]] §4's "Continue (+N turns)" is replaced by decision 5, and §5 ("no total cap") flips:
  a human no longer presses every Continue, so the cap is what bounds an unattended run. D-094's
  rejection of automatic resume is superseded for progressing runs and for transient-fault retries.
  Its PD-340 concern (a broken tree poisoning every retry) is bounded by D-055's identical-signature
  promotion and by restoring only the interrupted run's own work.
- [[D-066]]'s per-ticket ceiling no longer applies to Robot runs. PD-967 removes it, and Refine's
  estimate from D-110, everywhere else.
- `finishRun` now keeps the live turn count when a run ends with no result message, so an
  interrupted or reclaimed run's turns carry into the episode total.
- New worker env: `CHECKPOINT_WINDOW_TURNS`, `CHECKPOINT_TOTAL_TURNS`, `CHECKPOINT_REPEAT_LIMIT`,
  `CHECKPOINT_JUDGE_MODEL`.
