import Database from 'better-sqlite3';
import type { GrillerConfig } from './config';
import { dbPathFor } from './config';

/**
 * Open the SHARED dashboard SQLite file — the same DB the web server owns. WAL lets
 * the web process and this worker read/write concurrently (writes serialize). The
 * griller reads Refine trigger rows (table lands in PD-268) and writes the grill
 * conversation to `agent_ticket_events`.
 */
export function openDb(config: GrillerConfig): Database.Database {
  const db = new Database(dbPathFor(config));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}
