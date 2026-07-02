import Database from 'better-sqlite3';
import path from 'node:path';
import { mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import type { CronLogger, CronRegistry } from './cron';

/**
 * Consistent SQLite snapshots (PD-33).
 *
 * `dashboard.db` runs in WAL mode, so a file-level copy of the `.db` + its
 * `-wal`/`-shm` sidecars (what an off-box backup like Hyper Backup does) can
 * capture an inconsistent instant — we hit exactly this during the D-025 prod
 * restore (4 MB uncheckpointed WAL). SQLite's online backup API produces a
 * standalone, guaranteed-consistent single file *while the app keeps writing*;
 * we drop it under the data volume so whatever ships that volume off-box
 * carries a coherent snapshot.
 *
 * In-process via node-cron (not a host script) so it ports off Synology to the
 * Mac Mini with zero platform coupling. Everything here takes its inputs as
 * parameters — no module-level DB — so it unit-tests without touching real data.
 */

const MS_PER_DAY = 86_400_000;

export interface RunBackupOptions {
  /** Directory snapshots are written to (created if missing). */
  backupDir: string;
  /** Delete a label's snapshots older than this many days (after a good new one). */
  retainDays: number;
  /** The app's own live connection — snapshot uses it directly (consistent, WAL-aware). */
  primarySource: Database.Database;
  /** Filename prefix for the primary snapshot, e.g. 'dashboard'. */
  primaryLabel: string;
  /**
   * Extra sqlite files to snapshot beyond the primary — e.g. Sortie's
   * `.sortie.db` once the runtime can reach it. Each is opened read-only; a
   * missing/unreadable path is logged and skipped, never fatal.
   */
  extraDbPaths: string[];
}

export interface BackupResult {
  label: string;
  ok: boolean;
  /** Absolute path of the snapshot, when it was written and verified. */
  file?: string;
  /** How many old snapshots for this label were pruned. */
  pruned: number;
}

/** ISO-8601 with `:`/`.` swapped for `-` so it's a legal filename on every FS. */
function fsSafeTimestamp(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Snapshot one open database to `destPath` and verify it. Returns true only if
 * the snapshot both wrote and passes `PRAGMA integrity_check`. A snapshot that
 * fails verification is deleted so it can never be mistaken for a good restore.
 */
export async function backupDatabase(
  source: Database.Database,
  destPath: string,
  log: CronLogger,
): Promise<boolean> {
  await source.backup(destPath);

  // A snapshot that fails integrity_check — or can't even be opened — is worse
  // than useless (it could be restored by mistake), so verify then delete on any
  // failure. Return false so the caller skips pruning good older snapshots.
  try {
    const check = new Database(destPath, { fileMustExist: true });
    try {
      // The snapshot inherits WAL mode from the source; collapse it to a single
      // self-contained rollback-journal file so no -wal/-shm sidecars ride along.
      // A lone .db is the whole point — one coherent file for the off-box backup.
      check.pragma('journal_mode = DELETE');
      const integrity = check.pragma('integrity_check', { simple: true }) as string;
      if (integrity === 'ok') return true;
      log.error(`backup: snapshot ${destPath} failed integrity_check (${integrity}); deleting`);
    } finally {
      check.close();
    }
  } catch (err) {
    log.error(`backup: cannot verify snapshot ${destPath}: ${err instanceof Error ? err.message : String(err)}; deleting`);
  }

  removeSnapshot(destPath);
  return false;
}

/** Remove a snapshot and any WAL/SHM sidecars it may have left behind. */
function removeSnapshot(destPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${destPath}${suffix}`;
    if (existsSync(f)) unlinkSync(f);
  }
}

/**
 * Delete snapshots for `label` older than `retainDays`. Only ever touches files
 * matching `<label>.<stamp>.db`, so it can't harm anything else in the dir.
 */
export function pruneOldBackups(
  backupDir: string,
  label: string,
  retainDays: number,
  log: CronLogger,
): number {
  const cutoff = Date.now() - retainDays * MS_PER_DAY;
  const re = new RegExp(`^${escapeRegExp(label)}\\..+\\.db$`);
  let pruned = 0;
  for (const name of readdirSync(backupDir)) {
    if (!re.test(name)) continue;
    const full = path.join(backupDir, name);
    if (statSync(full).mtimeMs < cutoff) {
      unlinkSync(full);
      pruned++;
    }
  }
  if (pruned > 0) log.info(`backup: pruned ${pruned} old "${label}" snapshot(s)`);
  return pruned;
}

/** Run one backup pass over the primary DB plus any reachable extra DBs. */
export async function runBackup(log: CronLogger, opts: RunBackupOptions): Promise<BackupResult[]> {
  mkdirSync(opts.backupDir, { recursive: true });
  const stamp = fsSafeTimestamp();
  const results: BackupResult[] = [];

  // Primary: use the live connection directly — same WAL, trivially consistent.
  results.push(await snapshotTarget(opts.primaryLabel, opts.primarySource, false, stamp, opts, log));

  // Extras: open read-only; the online backup API is safe against a concurrent writer.
  for (const extraPath of opts.extraDbPaths) {
    // Strip leading dots (dotfiles like .sortie.db) then the extension → 'sortie'.
    const label = path.basename(extraPath).replace(/^\.+/, '').replace(/\.[^.]+$/, '') || 'extra';
    let source: Database.Database;
    try {
      source = new Database(extraPath, { readonly: true, fileMustExist: true });
    } catch (err) {
      log.error(`backup: cannot open extra DB ${extraPath}; skipping (${err instanceof Error ? err.message : String(err)})`);
      results.push({ label, ok: false, pruned: 0 });
      continue;
    }
    results.push(await snapshotTarget(label, source, true, stamp, opts, log));
  }

  return results;
}

async function snapshotTarget(
  label: string,
  source: Database.Database,
  ownsConnection: boolean,
  stamp: string,
  opts: RunBackupOptions,
  log: CronLogger,
): Promise<BackupResult> {
  const dest = path.join(opts.backupDir, `${label}.${stamp}.db`);
  try {
    const ok = await backupDatabase(source, dest, log);
    // Prune only after a verified new snapshot, so a bad run never eats good backups.
    const pruned = ok ? pruneOldBackups(opts.backupDir, label, opts.retainDays, log) : 0;
    if (ok) log.info(`backup: wrote ${dest}`);
    return { label, ok, file: ok ? dest : undefined, pruned };
  } finally {
    if (ownsConnection) source.close();
  }
}

/**
 * Register the daily backup job. Config via env (all optional):
 *   BACKUP_CRON            cron schedule           (default '0 3 * * *' — 03:00 daily)
 *   BACKUP_RETAIN_DAYS     snapshot retention      (default 14)
 *   BACKUP_DIR             output dir              (default <dataDir>/backups)
 *   BACKUP_EXTRA_DB_PATHS  comma-separated extras  (e.g. Sortie's .sortie.db)
 */
export function registerBackupJob(
  registry: CronRegistry,
  log: CronLogger,
  primarySource: Database.Database,
  defaultBackupDir: string,
): void {
  const schedule = process.env.BACKUP_CRON ?? '0 3 * * *';
  const opts: RunBackupOptions = {
    backupDir: process.env.BACKUP_DIR ?? defaultBackupDir,
    retainDays: Number(process.env.BACKUP_RETAIN_DAYS ?? 14),
    primarySource,
    primaryLabel: 'dashboard',
    extraDbPaths: (process.env.BACKUP_EXTRA_DB_PATHS ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean),
  };
  registry.register('db-backup', schedule, async () => {
    await runBackup(log, opts);
  });
}
