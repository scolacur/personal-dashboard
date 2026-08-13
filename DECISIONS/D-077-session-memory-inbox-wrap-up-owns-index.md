# D-077: A human session writes to the memory inbox too, and `MEMORY.md` becomes a wrap-up-only write (PD-513)

**Decision:** `MEMORY/runs/` stops being Robot-only. A human session writes its memory to its own
inbox file, `MEMORY/runs/YYYY-MM-DD-session-HHMM.md`, named by `/harness` at bootstrap, and
`/wrap-up` folds that file into the day file and deletes it — the same curation step [[D-071]]
already defines for a Robot run. A wrap-up folds **its own** session file plus any **merged** run
files, and never touches another session's. `MEMORY/MEMORY.md` is written **only** at wrap-up.

**Reasoning:**

- **D-071 solved this problem and then scoped the solution to the wrong half of the writers.** Its
  own reasoning — "`MEMORY/YYYY-MM-DD.md` is a single file that concurrent Robots *and human
  sessions* would all append to" — names human sessions explicitly, and then
  `MEMORY/runs/README.md` restricted the directory to Robots. Meanwhile dispatch has been paused
  since 2026-07-30, so **every collision that has actually happened was human-vs-human**: two
  sessions on the day file, and D-056 (PRs #235/#237, undetected for three weeks) and D-065
  (2026-08-05) on the decision log. The mechanism was built and not pointed at the live problem.
- **Several sessions run concurrently as a matter of course here.** The cost is not an occasional
  merge conflict; it is daily churn that burns tokens and time in every parallel session. That is
  why this gates raising Robot concurrency (PD-512) rather than being tidy-up.
- **One inbox, not two.** A separate `MEMORY/sessions/` would mean two directories sharing one
  curation step, one README and one failure mode. Provenance is already legible from the filename —
  `-session-HHMM` against a Robot's branch name — which is the whole distinction needed.
- **Wrap-up folds only its own file, because the others may be live.** A run file arrives via a
  merged PR and is complete by construction; another session's inbox file may belong to a session
  still in progress, where folding it steals content and deleting it loses work. "Fold everything
  you find" would have been simpler and would corrupt precisely the concurrent case this exists for.
- **`MEMORY.md` becomes wrap-up-only rather than getting an inbox of its own.** It is one
  navigational line per day whose content is only knowable once the day's entries are folded, so the
  write belongs at the end rather than on every signal. That removes the contention without adding a
  second thing to curate. The session-start aging pass still rewrites it, which is rare, bounded,
  and happens before any parallel work begins.
- **The Robot's read path is untouched.** `buildOrientation` still reads `MEMORY/YYYY-MM-DD.md` for
  today and yesterday. The day file is still the record; only who writes to it directly has changed.

**Implications:** the change lives in `/harness` Step 6 and `~/.claude/commands/wrap-up.md` Step 2,
so it applies to every project that has a `MEMORY/runs/` directory and degrades to today's behaviour
for those that don't. `MEMORY/runs/` is no longer "the Robot's memory inbox" but "the memory inbox".
Core's [[D-027]] is amended to match, since the wiki trial's agent raw-write layer is now live in a
different shape than D-027 (6) specified.

**Revisit if:** inbox files routinely survive wrap-up — D-071's existing trigger, now covering two
kinds of writer. That is a signal about the curation owner, not about the format.
