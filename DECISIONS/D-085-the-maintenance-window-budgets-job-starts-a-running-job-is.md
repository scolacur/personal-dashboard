# D-085: The maintenance window budgets job STARTS; a running job is never cancelled (PD-546)

**Decision:** the 30-minute hold window is a bound on when a maintenance job may **begin**, not a
deadline it will be stopped at. Before each job in the hold, the coordinator checks the window still
has room; if it does not, that job and the ones behind it are deferred to the next hold and the
window closes. A job already running is always allowed to finish, even past the window. A **manual**
hold, which normally stays open so "Run now" is usable, closes instead when its jobs overran — there
is no rest-of-the-window left to keep open for.

**Reasoning:**

- **Cancelling a maintenance job is more dangerous than overrunning.** The first subscriber is
  decision consolidation, which renames provisional ids across the tree, commits, pushes and opens a
  PR. Interrupting it between the rewrite and the push leaves a branch that renamed half the
  citations — precisely the state the whole hold exists to prevent. A deadline you enforce by
  killing work turns a bounded delay into a corrupted repository.
- **So the guarantee is deliberately the weaker, honest one.** Not "the hold never exceeds 30
  minutes" — it can, by at most the length of the single job already running. What is guaranteed is
  that nothing *new* starts once the window is spent, so the overrun cannot compound across a list
  of jobs. That bound is only as good as the individual jobs are short, which is the reason a job
  that could plausibly exceed the window on its own belongs in a hold of its own rather than
  appended to this list.
- **The check has to be per-job, not once up front.** The whole point is that the jobs ahead of this
  one have already spent some of the window. Deciding the schedule before the first job runs would
  budget against an estimate nobody has.
- **Without this the window check could not fire at all.** `tick` awaits the job loop, and the
  "window elapsed → close the hold" branch lives in the *next* tick. Two slow jobs therefore held
  dispatch for as long as they took, with the bound sitting in unreachable code. The bug was not a
  missing limit; it was a limit that could only be evaluated once it no longer mattered.

**Consequences:** a deferred job waits for the next hold, which is what makes deferral safe — the
cadence is unconditional (`D-082`), so "next hold" is at most 24h away and is not contingent
on anyone noticing. The hold records how many jobs it deferred in its note, so a job that never
seems to run is diagnosable from the hold log rather than only from worker logs.
