# D-107: A circuit breaker pauses the whole loop after N consecutive deterministic failures across distinct tickets

The Robot loop halted the whole line only on a **system-wide** fault (auth/credit 401/403,
`faults.ts`). A **deterministic** fault parked just that one ticket (`stuck`) and dispatch carried
on. That is right for a one-off, but wrong when run after run fails the same structural way — a
broken base, a setup fault the whole batch trips, a path-guard every ticket hits. With the promoter
feeding the Queue automatically (D-103), nothing stopped the line in that case. This decision adds
the stop. It owns three non-obvious choices.

## 1. It counts DISTINCT tickets, not raw failures

One ticket flapping is already handled per-ticket by the retry cap and the transient→deterministic
promotion (`faults.ts`, D-055). The breaker is for a *systemic* failure — many different tickets
failing the same way — so the streak dedupes by `ticketId`: a ticket already in it refreshes its
signature but does not grow the count. Without this, a single ticket that a human keeps Unsticking
could trip a loop-wide pause on its own, which blames the wrong thing.

## 2. It counts only DETERMINISTIC-tier parks

A park can be either tier. A `deterministic` park is "this will fail identically again"; a
`transient` park is this ticket's own retry budget running out. The ticket is explicit that
transient retries do not count, so the breaker is fed only where `decision.tier === 'deterministic'`
(which includes a transient *promoted* to deterministic). "Consecutive" is enforced by resetting the
streak on any successful hand-off; a transient retry in between neither counts nor resets.

## 3. It reuses the single `dispatch_paused` flag, not a new halt

The loop already has four halt concepts (`dispatch_paused`, session-limit hold, maintenance hold,
budget pause). A breaker trip calls the existing `pauseDispatch` (D-072) rather than adding a fifth.
Consequences, all wanted:

- **Resume is the existing control.** `POST …/robot/resume` → `setDispatchPaused(db, false)` clears
  it. That same call also nulls the breaker's streak slot, because resume is the only human reset.
- **Dev Ops already renders it.** The pause reason is shown verbatim on Site Status and summarised
  in the nav killswitch; it is made *distinguishable* purely by the `circuit-breaker` token in the
  reason string (the nav shows "Circuit breaker tripped").
- **It always waits for a human** — a `dispatch_paused` pause never self-resumes (unlike the holds),
  which is exactly right for a breaker: auto-resuming into the same broken state would re-burn the
  board (the PD-320/#202 failure mode).

The streak itself lives in its **own** `robot_state` slot (`breaker_consecutive`), following the
one-condition-one-slot discipline the holds in `state.ts` use — the list is both the count (its
length) and the evidence the trip notification needs (which tickets, which signatures). Threshold is
`ROBOT_BREAKER_FAILURES` (default 3; 0 disables).
