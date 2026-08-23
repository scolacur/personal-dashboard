import Database from 'better-sqlite3';
import path from 'node:path';
import { mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { DB_BACKUP_JOB } from '@dashboard/shared';
import { recordRun } from './lib/job-runs';
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
   * Extra sqlite files to snapshot beyond the primary — e.g. an auxiliary
   * `.extra.db` a sidecar process owns. Each is opened read-only; a
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
  /** What verification actually measured. Absent only when the source could not be opened. */
  check?: SnapshotCheck;
}

/** ISO-8601 with `:`/`.` swapped for `-` so it's a legal filename on every FS. */
function fsSafeTimestamp(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Snapshot completeness thresholds.
 *
 * Neither is an equality check, and that is deliberate — see `checkSnapshot`.
 */
/** Snapshot rows must reach this share of the source's. Slack absorbs writes that land mid-run. */
const MIN_ROW_RATIO = 0.95;
/** Snapshot bytes must reach this share of the source file's. Coarse: only catches a stub. */
const MIN_SIZE_RATIO = 0.5;

export interface SnapshotCheck {
  ok: boolean;
  /** Why it failed, for the log and the run summary. Absent when `ok`. */
  reason?: string;
  sourceTables: number;
  snapshotTables: number;
  /** Tables present in the source but missing from the snapshot. */
  missingTables: string[];
  sourceRows: number;
  snapshotRows: number;
  sourceBytes: number;
  snapshotBytes: number;
}

/** Every user table in an open DB, `sqlite_*` internals excluded. */
function tableNames(db: Database.Database): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

/** Total rows across every user table. The one number that says "the data is in there". */
function totalRows(db: Database.Database, tables: string[]): number {
  let total = 0;
  for (const t of tables) {
    // Identifier, not a bindable parameter — quoted so an exotic table name can't break the SQL.
    const row = db.prepare(`SELECT COUNT(*) AS n FROM "${t.replace(/"/g, '""')}"`).get() as { n: number };
    total += row.n;
  }
  return total;
}

function fileSize(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

/**
 * Does this snapshot actually contain the database?
 *
 * **`PRAGMA integrity_check` is not enough, and that is the whole reason this exists.** It answers
 * "is this file structurally valid SQLite", and a *completely empty* database answers `ok`. So does
 * a schema-only one. A backup that silently captured nothing would pass every check the job had
 * before this, and would be discovered at the only moment it matters — a restore.
 *
 * Three checks, weakest to strongest:
 *
 * - **Size floor.** Coarse and deliberately generous: a snapshot is checkpointed to a single file
 *   while the live DB carries a separate `-wal`, so the two legitimately differ in both directions
 *   and cannot be compared for equality. It only catches the near-empty stub.
 * - **Schema parity.** Every source table must exist in the snapshot. This is what catches a
 *   partial copy that is nonetheless valid SQLite.
 * - **Row-count floor.** The real check. Not equality: `.backup()` is a point-in-time copy and the
 *   app keeps writing, so the source can legitimately be *ahead* by the time it is counted. The
 *   snapshot may not be meaningfully *behind*.
 */
export function checkSnapshot(
  source: Database.Database,
  snapshot: Database.Database,
  sourcePath: string,
  snapshotPath: string,
): SnapshotCheck {
  const sourceTableList = tableNames(source);
  const snapshotTableList = tableNames(snapshot);
  const snapshotSet = new Set(snapshotTableList);
  const missingTables = sourceTableList.filter((t) => !snapshotSet.has(t));

  const sourceRows = totalRows(source, sourceTableList);
  const snapshotRows = totalRows(snapshot, snapshotTableList);
  const sourceBytes = fileSize(sourcePath);
  const snapshotBytes = fileSize(snapshotPath);

  const base: Omit<SnapshotCheck, 'ok' | 'reason'> = {
    sourceTables: sourceTableList.length,
    snapshotTables: snapshotTableList.length,
    missingTables,
    sourceRows,
    snapshotRows,
    sourceBytes,
    snapshotBytes,
  };

  if (missingTables.length > 0) {
    return { ...base, ok: false, reason: `snapshot is missing ${missingTables.length} table(s): ${missingTables.join(', ')}` };
  }
  if (sourceRows > 0 && snapshotRows < Math.floor(sourceRows * MIN_ROW_RATIO)) {
    return { ...base, ok: false, reason: `snapshot holds ${snapshotRows} rows against the source's ${sourceRows}` };
  }
  if (sourceBytes > 0 && snapshotBytes < Math.floor(sourceBytes * MIN_SIZE_RATIO)) {
    return { ...base, ok: false, reason: `snapshot is ${snapshotBytes} bytes against the source's ${sourceBytes}` };
  }
  return { ...base, ok: true };
}

/**
 * Snapshot one open database to `destPath` and verify it. `ok` only when the snapshot wrote,
 * passed `PRAGMA integrity_check`, **and** carries the source's schema and rows (`checkSnapshot`).
 * A snapshot that fails any of those is deleted so it can never be mistaken for a good restore.
 */
export async function backupDatabase(
  source: Database.Database,
  destPath: string,
  log: CronLogger,
  sourcePath?: string,
): Promise<SnapshotCheck> {
  const empty = {
    sourceTables: 0,
    snapshotTables: 0,
    missingTables: [] as string[],
    sourceRows: 0,
    snapshotRows: 0,
    sourceBytes: sourcePath ? fileSize(sourcePath) : 0,
    snapshotBytes: 0,
  };

  await source.backup(destPath);

  // A snapshot that fails verification — or can't even be opened — is worse than useless (it
  // could be restored by mistake), so verify then delete on any failure. A failed result also
  // makes the caller skip pruning, so a bad run never eats good backups.
  try {
    const check = new Database(destPath, { fileMustExist: true });
    try {
      // The snapshot inherits WAL mode from the source; collapse it to a single
      // self-contained rollback-journal file so no -wal/-shm sidecars ride along.
      // A lone .db is the whole point — one coherent file for the off-box backup.
      check.pragma('journal_mode = DELETE');
      const integrity = check.pragma('integrity_check', { simple: true }) as string;
      if (integrity !== 'ok') {
        log.error(`backup: snapshot ${destPath} failed integrity_check (${integrity}); deleting`);
        removeSnapshot(destPath);
        return { ...empty, ok: false, reason: `integrity_check: ${integrity}` };
      }

      // Structurally valid is not the same as complete — an empty DB passes the check above.
      const result = checkSnapshot(source, check, sourcePath ?? '', destPath);
      if (!result.ok) {
        log.error(`backup: snapshot ${destPath} is incomplete — ${result.reason}; deleting`);
        removeSnapshot(destPath);
        return result;
      }
      log.info(
        `backup: verified ${destPath} — ${result.snapshotTables} tables, ${result.snapshotRows} rows, ${result.snapshotBytes} bytes`,
      );
      return result;
    } finally {
      check.close();
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error(`backup: cannot verify snapshot ${destPath}: ${reason}; deleting`);
    removeSnapshot(destPath);
    return { ...empty, ok: false, reason };
  }
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
    // Strip leading dots (dotfiles like .extra.db) then the extension → 'extra'.
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
    // `.name` is better-sqlite3's path for the open file — the size check needs it, and taking it
    // from the handle keeps callers from having to pass a path that could disagree with it.
    const check = await backupDatabase(source, dest, log, source.name);
    // Prune only after a verified new snapshot, so a bad run never eats good backups.
    const pruned = check.ok ? pruneOldBackups(opts.backupDir, label, opts.retainDays, log) : 0;
    if (check.ok) log.info(`backup: wrote ${dest}`);
    return { label, ok: check.ok, file: check.ok ? dest : undefined, pruned, check };
  } finally {
    if (ownsConnection) source.close();
  }
}

/**
 * Register the daily backup job. Config via env (all optional):
 *   BACKUP_CRON            cron schedule           (default '0 3 * * *' — 03:00 daily)
 *   BACKUP_RETAIN_DAYS     snapshot retention      (default 14)
 *   BACKUP_DIR             output dir              (default <dataDir>/backups)
 *   BACKUP_EXTRA_DB_PATHS  comma-separated extras  (e.g. a sidecar's .extra.db)
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
    // Recorded to `job_runs` (PD-442) so a verification failure is a visible run on the Dev Ops
    // Jobs surface rather than one line in a container log nobody reads. Before this, the only
    // evidence the nightly backup had ever run was the files themselves — which is exactly the
    // wrong place to find out it stopped.
    await recordRun(primarySource, DB_BACKUP_JOB, async (ctx) => {
      const results = await runBackup(log, opts);
      const primary = results.find((r) => r.label === opts.primaryLabel);
      const failed = results.filter((r) => !r.ok);

      ctx.setSummary({
        targets: results.length,
        verified: results.length - failed.length,
        failed: failed.length,
        tables: primary?.check?.snapshotTables ?? 0,
        rows: primary?.check?.snapshotRows ?? 0,
        bytes: primary?.check?.snapshotBytes ?? 0,
        pruned: results.reduce((n, r) => n + r.pruned, 0),
      });

      // A failure here is not thrown: the extras are best-effort by design, and a thrown run
      // would lose the summary's numbers. `setOutcome` records it honestly instead — `error`
      // when nothing was backed up at all, `partial` when the primary survived but an extra
      // did not.
      if (failed.length > 0) {
        const detail = failed.map((r) => `${r.label}: ${r.check?.reason ?? 'unknown'}`).join('; ');
        ctx.setOutcome(primary?.ok ? 'partial' : 'error', detail);
      }
      return results;
    });
  });
}
