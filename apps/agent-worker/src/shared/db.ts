import Database from 'better-sqlite3';
import type { AgentWorkerConfig } from './config';
import { dbPathFor } from './config';

/**
 * Open the SHARED dashboard SQLite file — the same DB the web server owns. WAL lets
 * the web process and this worker read/write concurrently (writes serialize). The
 * refine job reads Refine trigger rows and writes the refine conversation to
 * `agent_ticket_events`; other jobs (audit, D-045) use their own tables.
 */
export function openDb(config: AgentWorkerConfig): Database.Database {
  const db = new Database(dbPathFor(config));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}
