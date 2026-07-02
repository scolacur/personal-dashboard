import Database from 'better-sqlite3';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

export const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), 'data');
mkdirSync(dataDir, { recursive: true });

export const dbPath = path.join(dataDir, 'dashboard.db');

export const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
