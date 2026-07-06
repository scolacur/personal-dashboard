# MEMORY — Personal Dashboard

One line per day. Load today's and yesterday's files at session start.

**Index rule:** one line per day, a single sentence, ≤ ~200 chars, navigational only — points at the day file, never summarizes it. Detail lives in the day file; durable decisions in `DECISIONS.md`. (Governed by `~/.claude/commands/wrap-up.md` Step 5.)

- [2026-07-05](2026-07-05.md) — PD-252 board hard-refresh fixed (on-demand GitHub sync, D-043); PD-256 Sortie review re-work fixed (`sortie-review-rework.yml` bridge, PR #143, D-042); grill auto-routing → **D-044** + epic PD-264 / slices PD-265–269; PD-265/266 shipped (PR #149/#150 merged), PD-267 started; NAS live-diag notes.
- [2026-07-04](2026-07-04.md) — PD-235 shell scaffold shipped (side nav + mobile yin-yang drawer, 8 page & 14 widget stubs, Widget flip-button fix, hello removed); gotcha: `vite dev` in a worktree 403s the client entry → no hydration, fix is `npm install` in the worktree.
- [2026-07-02](2026-07-02.md) — Mac Mini migration mechanics finalized (D-034, resolving D-031's open items); board reconciled — PD-188 enriched from stub, preview trio PD-15/16/44 superseded, created PD-198/199/200.
- [2026-07-01](2026-07-01.md) — shared/dist killed — web + server consume shared from source (D-022→D-024); prod DB restored + seed-if-empty guard + DEV banner (D-025); Mission Control board UX — Queued lane + drag-and-drop + search + full-width (D-026); priority → nullable P0–P5 + status lock + duplicate + priority legend (D-028); Agent Dashboard Kanban + migration framework + 246-ticket seed built (D-020/D-021); Mac Mini M4 to become primary host + branch-preview design grilled/deferred, migrate-first (→ D-031/D-034).
- [2026-06-30](2026-06-30.md) — CI/CD deployed + proven live on NAS (port 8088); Sortie exit-128 root-caused, watchdog + ask_human + P1 handoff-fix built/verified (D-016/D-017); TODO→Sortie Kanban Phase 1 (D-018).
- [2026-06-29](2026-06-29.md) — SCSS-in-own-files convention decided (`<style lang=scss src>` + svelte-preprocess); documented in PROJECT.md §5.
- [2026-06-28](2026-06-28.md) — Sortie-readiness: ESLint/Prettier + vitest (6→41 tests), hardened `verify` to main (PR #1), pilot issue #2 authored.
- [2026-06-27](2026-06-27.md) — Session start — background: Symphony sibling project (D-013/D-014), Music Tracker steps 1–4 done.

*(Older days archived — see [archive/INDEX.md](archive/INDEX.md).)*
