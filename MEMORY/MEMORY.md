# MEMORY — Personal Dashboard

One line per day. Load today's and yesterday's files at session start.

- [2026-06-30](2026-06-30.md) — CI/CD pipeline AUTHORED + DEPLOYED + PROVEN: verify-on-PR + GHCR build + Watchtower pull-deploy; app LIVE on NAS (PRs #9–#15). NAS facts: `docker-compose` v1, app on **port 8088** (gluetun owns 8080), DJ library at `/volume1/music/dj-library/tracks`, public GHCR, Dockerfile compiles better-sqlite3 (no musl prebuild) + copies pruned node_modules. Version stamp at `/api/health`. Compose changes need manual NAS `git pull`+`up`.
- [2026-06-29](2026-06-29.md) — SCSS convention: styles always in own files (`<style lang="scss" src>`); needs svelte-preprocess (vitePreprocess ignores `src`) + sass; documented in PROJECT.md §5.
- [2026-06-28](2026-06-28.md) — Sortie-readiness: shipped ESLint/Prettier + vitest (6→41 tests) + hardened `verify` to `main` (PR #1 merged), normalized repo, authored pilot issue #2; only #6–7 (Sortie/NAS) left.
- [2026-06-27](2026-06-27.md) — Session start. Background: Symphony sibling project (D-013/D-014); Music Tracker steps 1–4 done.
- [2026-05-26](2026-05-26.md) — Session start. Background: Symphony sibling project (D-013/D-014); Music Tracker steps 1–4 done.
- [2026-05-25](2026-05-25.md) — Reconciled agent-dashboard PROJECT.md; D-013/D-014 added: Symphony standalone in multi-agent-linear-workflow/, Claude Code as runner, Mission Control UI in Dashboard consuming Symphony API.
- [2026-05-24](2026-05-24.md) — Session initialized. Project in design/planning phase, no code yet.
