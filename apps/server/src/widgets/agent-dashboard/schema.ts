import type Database from 'better-sqlite3';
import { migrate, addColumn } from '../../migrate';

// Agent Dashboard schema: a cross-project Ticket backlog (Kanban), the projects those
// Tickets belong to, plus relations / tags / events / reminders. All evolution goes
// through the migration framework so we never drop/recreate a populated table (D-021).
//
// CREATE statements reflect the full current schema (fresh DBs are complete in one shot);
// the addColumn migrations bring pre-existing tables up to date (no-ops on a fresh DB).
export function bootstrapSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_projects (
      id             INTEGER PRIMARY KEY,
      slug           TEXT    NOT NULL UNIQUE,
      name           TEXT    NOT NULL,
      key            TEXT,                          -- display-id prefix, e.g. 'PD'
      seq            INTEGER NOT NULL DEFAULT 0,    -- last-issued display-id number
      github_repo    TEXT,
      sortie_enabled INTEGER NOT NULL DEFAULT 0,
      color          TEXT,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_tickets (
      id                  INTEGER PRIMARY KEY,
      display_id          TEXT,                     -- e.g. 'PD-7' (assigned on create)
      title               TEXT    NOT NULL,
      body                TEXT,
      status              TEXT    NOT NULL DEFAULT 'backlog',
      priority            TEXT    NOT NULL DEFAULT 'medium',
      project_id          INTEGER,
      assignee            TEXT,
      recur_interval      TEXT,                     -- e.g. 'weekly' for maintenance tickets
      source              TEXT    NOT NULL DEFAULT 'manual',
      sort_order          REAL    NOT NULL DEFAULT 0,
      github_issue_number INTEGER,
      github_issue_url    TEXT,
      archived_at         INTEGER,                  -- soft delete; NULL = active
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_tickets_status ON agent_tickets (status, sort_order);
    CREATE INDEX IF NOT EXISTS idx_agent_tickets_project ON agent_tickets (project_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tickets_display_id
      ON agent_tickets (display_id) WHERE display_id IS NOT NULL;

    -- Ticket links (blocks / relates / duplicates). "Blocking" = rows where you're
    -- from_ticket_id; "blocked by" = rows where you're to_ticket_id.
    CREATE TABLE IF NOT EXISTS agent_ticket_relations (
      id            INTEGER PRIMARY KEY,
      from_ticket_id  INTEGER NOT NULL REFERENCES agent_tickets(id) ON DELETE CASCADE,
      to_ticket_id    INTEGER NOT NULL REFERENCES agent_tickets(id) ON DELETE CASCADE,
      type          TEXT    NOT NULL DEFAULT 'blocks',
      created_at    INTEGER NOT NULL,
      UNIQUE(from_ticket_id, to_ticket_id, type)
    );

    -- Arbitrary, extensible tags.
    CREATE TABLE IF NOT EXISTS agent_tags (
      id         INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL UNIQUE,
      color      TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_ticket_tags (
      ticket_id    INTEGER NOT NULL REFERENCES agent_tickets(id) ON DELETE CASCADE,
      tag_id     INTEGER NOT NULL REFERENCES agent_tags(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (ticket_id, tag_id)
    );

    -- Activity log — powers the future Activity Feed + cycle-time history.
    CREATE TABLE IF NOT EXISTS agent_ticket_events (
      id         INTEGER PRIMARY KEY,
      ticket_id    INTEGER NOT NULL REFERENCES agent_tickets(id) ON DELETE CASCADE,
      type       TEXT    NOT NULL,                  -- created | status_changed | archived | ...
      detail     TEXT,                              -- JSON blob (e.g. {"from":"backlog","to":"ready"})
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_ticket_events_ticket ON agent_ticket_events (ticket_id, created_at);

    -- Reminders — many per ticket; a future job sends when remind_at passes.
    CREATE TABLE IF NOT EXISTS agent_ticket_reminders (
      id         INTEGER PRIMARY KEY,
      ticket_id    INTEGER NOT NULL REFERENCES agent_tickets(id) ON DELETE CASCADE,
      remind_at  INTEGER NOT NULL,
      note       TEXT,
      sent_at    INTEGER,                           -- NULL until delivered
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_ticket_reminders_due
      ON agent_ticket_reminders (remind_at) WHERE sent_at IS NULL;
  `);

  // Bring pre-existing tables (older dev DBs) up to the current schema. Each is a
  // no-op on a fresh DB where the CREATE above already included the column.
  migrate(db, 'agent_projects_add_key_seq', (d) => {
    addColumn(d, 'agent_projects', 'key', 'TEXT');
    addColumn(d, 'agent_projects', 'seq', 'INTEGER NOT NULL DEFAULT 0');
  });
  migrate(db, 'agent_tickets_add_project_id', (d) => {
    addColumn(d, 'agent_tickets', 'project_id', 'INTEGER');
  });
  migrate(db, 'agent_tickets_add_lifecycle_fields', (d) => {
    addColumn(d, 'agent_tickets', 'display_id', 'TEXT');
    addColumn(d, 'agent_tickets', 'assignee', 'TEXT');
    addColumn(d, 'agent_tickets', 'recur_interval', 'TEXT');
    addColumn(d, 'agent_tickets', 'archived_at', 'INTEGER');
  });

  // Seed the known projects once (with display-id keys). Idempotent, and backfills
  // the key on any project a prior seed created before `key` existed.
  migrate(db, 'seed_projects', (d) => {
    const now = Date.now();
    const insert = d.prepare(
      `INSERT OR IGNORE INTO agent_projects (slug, name, key, github_repo, sortie_enabled, color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run('personal-dashboard', 'Personal Dashboard', 'PD', 'scolacur/personal-dashboard', 1, '#7c3aed', now, now);
    insert.run('core', 'Core', 'C', 'scolacur/core', 0, '#0d9488', now, now);
    insert.run('nervous-system-website', 'Nervous System Website', 'NSW', null, 0, '#d97706', now, now);
    const setKey = d.prepare('UPDATE agent_projects SET key = ? WHERE slug = ? AND key IS NULL');
    setKey.run('PD', 'personal-dashboard');
    setKey.run('C', 'core');
    setKey.run('NSW', 'nervous-system-website');
  });

  // Seed starter tags.
  migrate(db, 'seed_tags', (d) => {
    const now = Date.now();
    const insert = d.prepare('INSERT OR IGNORE INTO agent_tags (name, color, created_at) VALUES (?, ?, ?)');
    insert.run('UI', '#2563eb', now);
    insert.run('Infra', '#a3a300', now);
  });
}
