import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { runBackup, pruneOldBackups, backupDatabase, checkSnapshot } from './backup';

const silentLog = { info: () => {}, error: () => {} };

let workDir: string;
let backupDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'pd-backup-'));
  backupDir = path.join(workDir, 'backups');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** A file-backed DB in WAL mode (matches prod) seeded with `count` rows. */
function seededDb(name: string, count: number): Database.Database {
  const db = new Database(path.join(workDir, name));
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  const insert = db.prepare('INSERT INTO t (v) VALUES (?)');
  for (let i = 0; i < count; i++) insert.run(`row-${i}`);
  return db;
}

function rowCount(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

describe('runBackup', () => {
  it('writes a consistent, integrity-clean snapshot preserving all rows', async () => {
    const source = seededDb('dashboard.db', 42);

    const results = await runBackup(silentLog, {
      backupDir,
      retainDays: 14,
      primarySource: source,
      primaryLabel: 'dashboard',
      extraDbPaths: [],
    });

    expect(results).toHaveLength(1);
    const [result] = results;
    expect(result.ok).toBe(true);
    expect(result.file).toBeDefined();
    expect(existsSync(result.file!)).toBe(true);
    // The whole point of PD-33: the snapshot is a coherent copy, not a torn WAL.
    expect(rowCount(result.file!)).toBe(42);
    source.close();
  });

  it('snapshots extra DB paths read-only and survives an unreachable one', async () => {
    const primary = seededDb('dashboard.db', 3);
    const extra = seededDb('.extra.db', 7);
    extra.close(); // opened read-only by runBackup, mimicking a foreign DB

    const results = await runBackup(silentLog, {
      backupDir,
      retainDays: 14,
      primarySource: primary,
      primaryLabel: 'dashboard',
      extraDbPaths: [path.join(workDir, '.extra.db'), path.join(workDir, 'nope.db')],
    });

    expect(results).toHaveLength(3);
    const byLabel = Object.fromEntries(results.map((r) => [r.label, r]));
    expect(byLabel['dashboard'].ok).toBe(true);
    expect(byLabel['extra'].ok).toBe(true);
    expect(rowCount(byLabel['extra'].file!)).toBe(7);
    // Missing path is logged + skipped, never fatal.
    expect(byLabel['nope'].ok).toBe(false);
    primary.close();
  });
});

describe('backupDatabase', () => {
  it('deletes a snapshot that fails integrity_check and reports not-ok', async () => {
    const source = seededDb('dashboard.db', 1);
    const dest = path.join(backupDir, 'dashboard.now.db');
    // Point at a "snapshot" location we pre-fill with garbage so the post-backup
    // verify reads a corrupt file. We stub .backup to no-op so `dest` stays garbage.
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(dest, 'not a sqlite file at all');
    const stub = { backup: async () => ({}) } as unknown as Database.Database;

    const result = await backupDatabase(stub, dest, silentLog);
    expect(result.ok).toBe(false);
    expect(existsSync(dest)).toBe(false); // corrupt snapshot removed
    source.close();
  });

  /**
   * The case the whole completeness check exists for. An empty database is *structurally valid*
   * SQLite — `PRAGMA integrity_check` answers `ok` — so before this check a backup that captured
   * nothing was indistinguishable from a good one, and would only be found out at a restore.
   */
  it('rejects a snapshot that is valid SQLite but empty', async () => {
    const source = seededDb('dashboard.db', 500);
    const dest = path.join(backupDir, 'dashboard.now.db');
    mkdirSync(backupDir, { recursive: true });

    // A real, well-formed, completely empty DB at the destination — and a source that no-ops
    // instead of writing over it, standing in for a backup that silently produced nothing.
    const emptyDb = new Database(dest);
    emptyDb.close();
    expect(new Database(dest).pragma('integrity_check', { simple: true })).toBe('ok');

    const stub = {
      backup: async () => ({}),
      prepare: source.prepare.bind(source),
      name: source.name,
    } as unknown as Database.Database;

    const result = await backupDatabase(stub, dest, silentLog, source.name);

    expect(result.ok).toBe(false);
    expect(result.sourceRows).toBe(500);
    expect(result.snapshotRows).toBe(0);
    expect(result.missingTables).toContain('t');
    expect(existsSync(dest)).toBe(false); // empty snapshot removed, never mistaken for good
    source.close();
  });

  it('accepts a real snapshot and reports what it measured', async () => {
    const source = seededDb('dashboard.db', 120);
    const dest = path.join(backupDir, 'dashboard.now.db');
    mkdirSync(backupDir, { recursive: true });

    const result = await backupDatabase(source, dest, silentLog, source.name);

    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.snapshotRows).toBe(120);
    expect(result.sourceRows).toBe(120);
    expect(result.missingTables).toEqual([]);
    expect(result.snapshotTables).toBe(result.sourceTables);
    expect(result.snapshotBytes).toBeGreaterThan(0);
    expect(existsSync(dest)).toBe(true);
    source.close();
  });

  /**
   * `.backup()` is a point-in-time copy while the app keeps writing, so the source can legitimately
   * be ahead of the snapshot by the time both are counted. Equality would make the job flap; only a
   * meaningful shortfall is a failure.
   */
  it('tolerates the source racing ahead of the snapshot', async () => {
    const source = seededDb('dashboard.db', 1000);
    const dest = path.join(backupDir, 'dashboard.now.db');
    mkdirSync(backupDir, { recursive: true });

    await source.backup(dest);
    // Simulate writes landing after the snapshot point: +2%, inside the 5% tolerance.
    const insert = source.prepare('INSERT INTO t (v) VALUES (?)');
    for (let i = 0; i < 20; i++) insert.run(`late-${i}`);

    const snapshot = new Database(dest, { readonly: true });
    const check = checkSnapshot(source, snapshot, source.name, dest);
    snapshot.close();

    expect(check.sourceRows).toBe(1020);
    expect(check.snapshotRows).toBe(1000);
    expect(check.ok).toBe(true);
    source.close();
  });
});

describe('pruneOldBackups', () => {
  it('removes only stale snapshots for the given label, keeping recent + foreign files', () => {
    mkdirSync(backupDir, { recursive: true });
    const old = path.join(backupDir, 'dashboard.2000-01-01.db');
    const recent = path.join(backupDir, 'dashboard.2099-01-01.db');
    const otherLabel = path.join(backupDir, 'extra.2000-01-01.db');
    const foreign = path.join(backupDir, 'notes.txt');
    for (const f of [old, recent, otherLabel, foreign]) writeFileSync(f, 'x');

    // Age `old` and `otherLabel` well past the window; leave `recent` fresh.
    const ancient = new Date('2000-01-02T00:00:00Z');
    utimesSync(old, ancient, ancient);
    utimesSync(otherLabel, ancient, ancient);

    const pruned = pruneOldBackups(backupDir, 'dashboard', 14, silentLog);

    expect(pruned).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true); // within retention
    expect(existsSync(otherLabel)).toBe(true); // different label, untouched
    expect(existsSync(foreign)).toBe(true); // not a snapshot, untouched
  });
});
