# MEMORY/runs — the Robot's memory inbox

One file per Robot run, written by the run itself on its own branch and merged with its PR
(PD-306). Named `YYYY-MM-DD-<branch>.md`, e.g. `2026-08-07-robot-412.md`.

**Why one file per run rather than appending to the day file.** `MEMORY/YYYY-MM-DD.md` is a single
file that concurrent Robots — and your own sessions — would all append to, which is the exact
conflict shape [[D-070]] was written to eliminate for decisions. One file per run means every writer
touches a different path and git merges them without anyone resolving a conflict, least of all an
unsupervised agent.

**This directory is an inbox, not the record.** `/wrap-up` reads these, folds the non-obvious parts
into the day file as a single curated entry, and deletes them. If files are piling up here, wrap-up
has not run — they are not lost, just uncurated.

**Nothing but a Robot writes here**, and a Robot writes nothing else under `MEMORY/`. The day files
and `MEMORY.md` stay human-curated.
