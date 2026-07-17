import type Database from 'better-sqlite3';
import { migrate, addColumn, columnExists } from '../../migrate';

// Task Monitor schema: a cross-project Ticket backlog (Kanban), the projects those
// Tickets belong to, plus relations / tags / events / reminders. All evolution goes
// through the migration framework so we never drop/recreate a populated table (D-021).
//
// CREATE statements reflect the full current schema (fresh DBs are complete in one shot);
// the addColumn migrations bring pre-existing tables up to date (no-ops on a fresh DB).
export function bootstrapSchema(db: Database.Database): void {
  // Ticket Audit engine (D-045, PD-283). Advisory only — findings never mutate a ticket;
  // the human applies decisions later (PD-287). CREATE IF NOT EXISTS is no-op-safe on both
  // fresh and existing DBs, so these need no addColumn migration.
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_run (
      id           INTEGER PRIMARY KEY,
      status       TEXT    NOT NULL DEFAULT 'requested',  -- requested|running|done|error
      scope        TEXT,                                   -- e.g. 'single:PD'
      model        TEXT,
      counts       TEXT,                                   -- JSON AuditRunCounts, set on finish
      started_at   INTEGER,
      finished_at  INTEGER,
      created_at   INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_run_status ON audit_run (status);

    CREATE TABLE IF NOT EXISTS audit_finding (
      id              INTEGER PRIMARY KEY,
      run_id          INTEGER NOT NULL REFERENCES audit_run(id) ON DELETE CASCADE,
      project_id      INTEGER,
      ticket_id       INTEGER,
      type            TEXT    NOT NULL,                    -- recommendation bucket
      recommendation  TEXT,
      reason          TEXT,
      evidence        TEXT,
      proposed_change TEXT,
      confidence      TEXT,                                -- high|medium|low (PD-284); nullable here
      decision        TEXT    NOT NULL DEFAULT 'undecided',-- undecided|accepted|rejected|other
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_finding_run ON audit_finding (run_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_projects (
      id             INTEGER PRIMARY KEY,
      slug           TEXT    NOT NULL UNIQUE,
      name           TEXT    NOT NULL,
      key            TEXT,                          -- display-id prefix, e.g. 'PD'
      seq            INTEGER NOT NULL DEFAULT 0,    -- last-issued display-id number
      github_repo    TEXT,
      robot_enabled  INTEGER NOT NULL DEFAULT 0,
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
      priority            TEXT    NOT NULL DEFAULT 'none',   -- P0–P5, or 'none' (unset)
      project_id          INTEGER,
      assignee            TEXT,
      recur_interval      TEXT,                     -- e.g. 'weekly' for maintenance tickets
      source              TEXT    NOT NULL DEFAULT 'manual',
      sort_order          REAL    NOT NULL DEFAULT 0,
      github_issue_number INTEGER,
      github_issue_url    TEXT,
      agent_state         TEXT,                     -- Robot loop agent state (D-055); NULL = none
      refined             INTEGER NOT NULL DEFAULT 0, -- 1 once refined to completion (D-044, PD-268)
      is_epic             INTEGER NOT NULL DEFAULT 0, -- 1 = an Epic umbrella (D-054, PD-336)
      epic_id             INTEGER REFERENCES agent_tickets(id), -- member's single parent Epic (D-054)
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
      -- Provenance (D-048): 'agent' (refine decompose / Ticket Audit) | 'human' (relations UI).
      -- Defaults 'agent' so pre-existing rows back-fill correctly (see the migrate step below).
      origin        TEXT    NOT NULL DEFAULT 'agent',
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

    -- Notification Center (D-040): in-app inbox. MVP source is the agent-park poller
    -- (awaiting-human / needs-human); widget notifications plug in later. A brand-new
    -- table, so CREATE IF NOT EXISTS covers both fresh and existing DBs (no migrate step).
    CREATE TABLE IF NOT EXISTS agent_notifications (
      id         INTEGER PRIMARY KEY,
      kind       TEXT    NOT NULL,                   -- NotificationKind (agent_awaiting_human, …)
      ticket_id  INTEGER REFERENCES agent_tickets(id) ON DELETE CASCADE,  -- null = not ticket-scoped
      title      TEXT    NOT NULL,
      body       TEXT,                               -- e.g. the agent's ask_human question
      read_at    INTEGER,                            -- NULL = unread
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_notifications_unread
      ON agent_notifications (read_at, created_at);

    -- Worker liveness beacons (Site Status). One row per long-lived worker process
    -- (e.g. the out-of-process agent-worker), which upserts its own row on an interval.
    -- The web server only READS this — it's how the dashboard knows the worker is alive
    -- without talking to it directly. The agent-worker also CREATEs this table defensively
    -- in case it boots before the server has ever bootstrapped the shared DB; that DDL
    -- must match this one. Brand-new table, so CREATE IF NOT EXISTS needs no migrate step.
    CREATE TABLE IF NOT EXISTS worker_heartbeat (
      worker      TEXT    PRIMARY KEY,
      started_at  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL,
      pid         INTEGER,
      sha         TEXT,
      model       TEXT
    );
  `);

  // Bring pre-existing tables (older dev DBs) up to the current schema. Each is a
  // no-op on a fresh DB where the CREATE above already included the column.

  // D-055 / C7: rename the legacy `sortie_enabled` column to `robot_enabled`. On a fresh DB the
  // CREATE above already made `robot_enabled`, so the guard skips; on an existing DB it renames
  // once. DEPLOY ORDER: the server (which runs bootstrapSchema) MUST boot and apply this migration
  // BEFORE the agent-worker queries `robot_enabled`, or the worker will hit a missing column.
  migrate(db, 'agent_projects_rename_sortie_enabled_to_robot', (d) => {
    if (columnExists(d, 'agent_projects', 'sortie_enabled') && !columnExists(d, 'agent_projects', 'robot_enabled')) {
      d.exec('ALTER TABLE agent_projects RENAME COLUMN sortie_enabled TO robot_enabled');
    }
  });
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
  migrate(db, 'agent_tickets_add_agent_state', (d) => {
    addColumn(d, 'agent_tickets', 'agent_state', 'TEXT');
  });
  migrate(db, 'agent_tickets_add_refined', (d) => {
    addColumn(d, 'agent_tickets', 'refined', 'INTEGER NOT NULL DEFAULT 0');
  });
  // D-054: Epic umbrella primitive (PD-336). `is_epic` flags an umbrella; `epic_id` is a member's
  // single parent Epic. Both default to non-epic / no-parent so every existing row back-fills.
  migrate(db, 'agent_tickets_add_epic_fields', (d) => {
    addColumn(d, 'agent_tickets', 'is_epic', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(d, 'agent_tickets', 'epic_id', 'INTEGER REFERENCES agent_tickets(id)');
  });
  // D-048: relation provenance. Default 'agent' back-fills every pre-existing row (all
  // refine-authored `split` links) correctly; the relations UI writes 'human'.
  migrate(db, 'agent_ticket_relations_add_origin', (d) => {
    addColumn(d, 'agent_ticket_relations', 'origin', "TEXT NOT NULL DEFAULT 'agent'");
  });

  // Remap legacy low/medium/high priorities to the P0–P5 scale ('none' = unset).
  // Data-only, non-destructive (updates values in place). No-op on a fresh/empty DB.
  migrate(db, 'agent_tickets_priority_to_p_levels', (d) => {
    d.prepare("UPDATE agent_tickets SET priority = 'P1' WHERE priority = 'high'").run();
    d.prepare(
      "UPDATE agent_tickets SET priority = 'P3' WHERE priority = 'medium' AND status IN ('in_progress', 'completed')",
    ).run();
    d.prepare(
      "UPDATE agent_tickets SET priority = 'none' WHERE priority = 'medium' AND status = 'backlog'",
    ).run();
    d.prepare("UPDATE agent_tickets SET priority = 'P4' WHERE priority = 'low'").run();
    // Safety net: any leftover legacy/invalid value (e.g. medium in ready/queued/in_review) → P3.
    d.prepare(
      "UPDATE agent_tickets SET priority = 'P3' WHERE priority NOT IN ('P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'none')",
    ).run();
  });

  // D-040 board redesign (PD-245): collapse the old 7 lanes into the new 6-lane model.
  // Data-only, non-destructive; no-op on a fresh DB. ready -> prioritized; the old agent
  // lanes queued/in_progress/in_review -> the single robot_queue lane. For issue-linked
  // rows, seed agent_state (the card pill) from the old status BEFORE collapsing it, and
  // only when the poller hasn't already set it; the live poller re-derives on next sync.
  migrate(db, 'agent_tickets_lanes_d040', (d) => {
    d.prepare("UPDATE agent_tickets SET status = 'prioritized' WHERE status = 'ready'").run();
    d.prepare(
      "UPDATE agent_tickets SET agent_state = 'working' WHERE status = 'in_progress' AND agent_state IS NULL AND github_issue_number IS NOT NULL",
    ).run();
    d.prepare(
      "UPDATE agent_tickets SET agent_state = 'in-review' WHERE status = 'in_review' AND agent_state IS NULL AND github_issue_number IS NOT NULL",
    ).run();
    d.prepare(
      "UPDATE agent_tickets SET agent_state = 'queued' WHERE status = 'queued' AND agent_state IS NULL AND github_issue_number IS NOT NULL",
    ).run();
    d.prepare(
      "UPDATE agent_tickets SET status = 'robot_queue' WHERE status IN ('queued', 'in_progress', 'in_review')",
    ).run();
  });

  // Seed the known projects once (with display-id keys). Idempotent, and backfills
  // the key on any project a prior seed created before `key` existed.
  migrate(db, 'seed_projects', (d) => {
    const now = Date.now();
    const insert = d.prepare(
      `INSERT OR IGNORE INTO agent_projects (slug, name, key, github_repo, robot_enabled, color, created_at, updated_at)
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
