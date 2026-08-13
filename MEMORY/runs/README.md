# MEMORY/runs — the memory inbox

One file per writer, never a shared one. Two kinds of file live here:

- **A Robot run** — written by the run itself on its own branch and merged with its PR (PD-306).
  Named `YYYY-MM-DD-<branch>.md`, e.g. `2026-08-07-robot-412.md`.
- **A human session** — written by the session as it goes, named by `/harness` at bootstrap
  (PD-513). Named `YYYY-MM-DD-session-HHMM.md`, e.g. `2026-08-12-session-1423.md`.

**Why one file per writer rather than appending to the day file.** `MEMORY/YYYY-MM-DD.md` is a
single file that concurrent Robots — and concurrent human sessions — would all append to, which is
the exact conflict shape [[D-070]] was written to eliminate for decisions. One file per writer means
every writer touches a different path and git merges them without anyone resolving a conflict, least
of all an unsupervised agent. Human sessions were originally left out of this ([[D-071]] scoped the
directory to Robots) even though they are the writers that have actually collided; [[D-077]]
corrects that.

**This directory is an inbox, not the record.** `/wrap-up` reads these, folds the non-obvious parts
into the day file as curated entries, and deletes them. If files are piling up here, wrap-up has not
run — they are not lost, just uncurated.

**A wrap-up folds its own session's file and any merged run files — and nothing else.** A run file
arrives via a merged PR, so it is complete by construction. Another session's inbox file may belong
to a session that is still open: folding it steals its content, deleting it loses work. Leave it;
the session that owns it will fold it at its own wrap-up.

**The day files and `MEMORY.md` remain the curated record.** `MEMORY.md` is written only at
wrap-up ([[D-077]]) — it is the last shared file in the memory system, and its one line per day is
only knowable once the day's entries have been folded in.
