# D-029: Consistent SQLite snapshots run in-process via node-cron, not a host script (PD-33)

**Decision:** Produce WAL-consistent SQLite snapshots from an **in-process `node-cron` job**
(`apps/server/src/backup.ts`, scheduled through a new `CronRegistry`), not a Synology Task Scheduler
shell script. Each run takes an online `.backup()` of the live `dashboard.db`, collapses the copy to
a **single self-contained file** (`journal_mode = DELETE`, no `-wal`/`-shm` sidecars), verifies it
with `PRAGMA integrity_check`, and writes it to `<DATA_DIR>/backups/` where the existing off-box
backup already ships it.

**Why in-process, not a host script (the `quota-refund.sh` pattern the ticket cited):**

- The app is **moving off Synology to a Mac Mini**, so anything bound to DSM Task Scheduler / host
  `/bin/sqlite3` would be throwaway. `node-cron` runs wherever Node runs → **ports with zero change**.
- It also builds the `CronRegistry` PROJECT.md §2 always specified but never had (the widget
  `registerCron` hook is now wired), which the music-tracker Spotify poller will reuse.

**Why the WAL matters (not theoretical):** the D-025 prod restore hit a 4 MB uncheckpointed WAL — a
file-level copy of the `.db` alone would have restored stale/empty data. `.backup()` + `journal_mode
= DELETE` yields one coherent file that's safe to ship and restore on its own.

**Design notes:** the module takes the DB handle and all paths as **parameters** (no module-level
`db` import) so it unit-tests without opening real data. It accepts optional **extra DB paths**
(opened read-only) so **Sortie's `.sortie.db`** can be added once the Mac Mini layout lets the runtime
reach it — scoped to `dashboard.db` for now (the precious, no-other-source-of-truth data). A snapshot
that fails verification is deleted, and pruning of old snapshots only runs **after** a good new one,
so a bad run never eats good backups. Config via env (`BACKUP_CRON`, `BACKUP_RETAIN_DAYS`,
`BACKUP_DIR`, `BACKUP_EXTRA_DB_PATHS`); defaults 03:00 daily / 14-day retention.

**Out of scope / revisit:** *shipping* snapshots off-box. On Synology, Hyper Backup → Backblaze
already carries `data/backups/`; on the Mac Mini a new off-box target (Backblaze/restic/etc.) will be
needed — orthogonal to producing the consistent file. The ticket's two 🧑 items stand while on
Synology: confirm Hyper Backup covers `/volume1/docker/`, and do one test restore.
