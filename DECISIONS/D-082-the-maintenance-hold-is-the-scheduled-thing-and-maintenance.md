# D-082: The maintenance hold is the scheduled thing, and maintenance jobs subscribe to it (PD-498; amends D-078)

**Decision:** invert D-078's arrangement. The **maintenance hold** becomes a first-class recurring
event with its own cadence, log and lifecycle; a **maintenance job** declares that it runs during
one and is invoked by the coordinator. Decision consolidation stops being a self-scheduling job that
takes a hold, and becomes the first subscriber. Cadence: one hold per **24h**, window **30 minutes**,
opened only once in-flight Robot runs have drained.

**Reasoning:**

- **The expensive part was never the work — it was the window.** D-078 gave consolidation its own
  interval and had it take a hold internally. But the hard, risky machinery is draining in-flight
  runs, holding dispatch, bounding the wait, and releasing safely under every exit path. A second
  maintenance job written that way would re-derive all of it, and would get some of it subtly wrong.
  Inverting means the second job implements a function and inherits the rest.
- **It is also the only arrangement that makes a manual trigger coherent.** "Run this job now" has
  no safe meaning on its own — the whole point is that these jobs must not run while Robots are
  editing files. It only means something *inside a window*, which requires the window to exist as a
  thing you can open, observe, and be inside. That is why the Dev Ops button opens a **hold**, and
  the per-job "Run now" is enabled only while one is open.
- **A manual request queues rather than fails.** Pressed while Robots are working, the hold cannot
  start — but refusing would be a button that does nothing precisely when the system is busiest. It
  queues and opens on drain. It is also deliberately allowed when a hold ran recently: the human
  asked, and the cadence is a floor for the *scheduled* trigger, not a ration.
- **A scheduled hold closes as soon as its jobs finish; a manual hold stays open for the window.**
  Different intents. The scheduled one exists to do its rounds and should give dispatch back
  immediately. The manual one exists because a human wants to press things, and closing it the
  instant the automatic pass ended would disable the buttons they opened it for.
- **The window is a ceiling, not a plan.** Thirty minutes is long enough to use and short enough
  that walking away costs one window instead of a day of dispatch. It is enforced twice, on purpose:
  the coordinator closes the hold, and the worker's own hold state lapses independently
  ([[D-081]]) so a dead coordinator cannot wedge dispatch shut.
- **The cadence is measured from the last hold that STARTED, not the last requested.** A hold that
  sat queued for hours because the queue was busy has not done its rounds, and counting it would
  silently skip a day of consolidation.
- **The web process may only request; the worker owns every transition.** Only the worker can tell
  whether runs have drained, so the button inserts a `queued` row and stops. Same DB-as-the-queue
  split the Robot loop already uses ([[D-055]]), and the same reason: the two processes coordinate
  through the database, never through HTTP.
- **The 409 on "Run now" outside a hold is not belt-and-braces, it is the rule.** The UI greys the
  button out; the route makes it *true*. A disabled button is a hint, and hints are bypassable.
- **Holds are logged with the runs that happened inside them**, via a join table rather than a
  `hold_id` column on `job_runs`. `job_runs` is generic infrastructure shared by widgets that know
  nothing about maintenance ([[D-074]]); it should not grow a column for one consumer.
- **A maintenance job is not a `RecurringJob`.** It has no cron, so the Jobs page renders it in its
  own section with "Runs: during every maintenance hold" instead of a computed next-fire time. A
  next-run time derived from a cron it does not have would be a fiction, and the Jobs page's whole
  value is that the times on it are real.

**Implications:** `DECISION_CONSOLIDATION_INTERVAL_MS` and `..._DRAIN_POLL_MS` are gone — the cadence
now lives in `HOLD_CADENCE_MS` in `packages/shared`, because the Dev Ops page has to state it and a
second copy is how a page ends up advertising a schedule the code does not keep (the PD-496 drift).
`DECISION_CONSOLIDATION_POLL_MS` replaces them and is only the coordinator's tick rate. The
`drain-timeout` cycle outcome became `runs-in-flight`, since the cycle no longer drains — it only
re-checks, as a guard.

**Revisit if:** a second maintenance job wants a different cadence from the first, which would mean
the hold is the wrong unit of scheduling and jobs need their own due-times inside it. Or if the
30-minute window is routinely hit rather than closing early, which would mean holds are being opened
speculatively rather than to do known work.
