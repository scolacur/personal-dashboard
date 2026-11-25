import type Database from 'better-sqlite3';
import { isReady } from '@dashboard/shared';
import { migrate, addColumn, columnExists } from '../../migrate';

// Task Monitor schema: a cross-project Ticket backlog (Kanban), the projects those
// Tickets belong to, plus relations / tags / events / reminders. All evolution goes
// through the migration framework so we never drop/recreate a populated table (D-021).
//
// CREATE statements reflect the full current schema (fresh DBs are complete in one shot);
// the addColumn migrations bring pre-existing tables up to date (no-ops on a fresh DB).
/** PD-896 backfill: a title that reads as a bug report — the whole word "bug", "bugfix" or
 *  "bugfixes". Not "bugs" ("bugs filed vs fixed" is metrics work about bugs, not a bug) and not
 *  "debug". A heuristic: the few it gets wrong are corrected by hand. Exported for its test. */
export const BUG_TITLE = /\bbug(?:fix(?:es)?)?\b/i;

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
      -- Relation findings (PD-828): the other end + the relation type. NULL on a single-ticket
      -- finding. Direction (D-051): ticket_id is the relation from-side, target_ticket_id the to-side.
      target_ticket_id INTEGER,
      relation_type   TEXT,                                -- blocks|relates|duplicates (relation findings)
      type            TEXT    NOT NULL,                    -- recommendation bucket
      recommendation  TEXT,
      reason          TEXT,
      evidence        TEXT,
      proposed_change TEXT,
      confidence      TEXT,                                -- high|medium|low (PD-284); nullable here
      fingerprint     TEXT,                                -- PD-285: stable hash for cross-run carry-forward; nullable
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
      audit_enabled  INTEGER NOT NULL DEFAULT 1,     -- Ticket Audit fan-out per-project pause (PD-284)
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
      refine_stale        INTEGER NOT NULL DEFAULT 0, -- 1 when an Epic WAS refined and its members changed since (PD-610)
      ready               INTEGER NOT NULL DEFAULT 0, -- 1 iff body is 4-section Ready (D-058); recomputed on body write
      ready_bypassed      INTEGER NOT NULL DEFAULT 0, -- 1 when a human queued a not-Ready robot ticket via confirm modal (D-058)
      max_turns           INTEGER,                  -- per-ticket run ceiling (PD-432); NULL = the loop's env default
      kind                TEXT,                     -- bug | feature | chore (PD-896); NULL = unclassified
      coder_area          TEXT,                     -- Coder code-area subtype (PD-880); NULL = unset (reads as 'general')
      is_epic             INTEGER NOT NULL DEFAULT 0, -- 1 = an Epic umbrella (D-054, PD-336)
      epic_id             INTEGER REFERENCES agent_tickets(id), -- member's single parent Epic (D-054)
      auto_queue_excluded INTEGER NOT NULL DEFAULT 0, -- 1 = Epic excluded from auto-queue (D-103, PD-808)
      close_reason        TEXT,                     -- why the system closed it: split|superseded|duplicate; NULL = plain/manual close or open (PD-888)
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
      -- The GROUNDING CHECKOUT's HEAD — what the agent READS, re-pulled continuously.
      sha         TEXT,
      -- The commit the running image was BUILT from — what the worker RUNS (PD-528).
      -- Null on an image built before the build-arg existed; the UI says so rather than guessing.
      build_sha   TEXT,
      model       TEXT,
      -- PD-816: 1 when no worker build input changed between build_sha and sha, so the worker is
      -- current even though main moved on. 0 when one did. NULL when the worker can't tell.
      build_current INTEGER
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
  // PD-284 (Ticket Audit fan-out): per-project pause for the Audit, mirroring `robot_enabled`.
  // NOT NULL DEFAULT 1 so every existing project back-fills to audited (the Audit was single-project
  // before, so "enabled" is the status-quo for all of them). Like `robot_enabled`, the server must
  // apply this migration before the agent-worker queries `audit_enabled`.
  migrate(db, 'agent_projects_add_audit_enabled', (d) => {
    addColumn(d, 'agent_projects', 'audit_enabled', 'INTEGER NOT NULL DEFAULT 1');
  });
  // PD-528: the running image's build commit, distinct from the grounding checkout's HEAD. The two
  // diverge the moment anything merges without a redeploy, which is precisely the state worth
  // seeing.
  migrate(db, 'worker_heartbeat_add_build_sha', (d) => {
    addColumn(d, 'worker_heartbeat', 'build_sha', 'TEXT');
  });
  // PD-816: the worker image now publishes only on worker-affecting merges, so build_sha trails
  // main after a web-only merge without being behind. The worker reports which case it's in.
  migrate(db, 'worker_heartbeat_add_build_current', (d) => {
    addColumn(d, 'worker_heartbeat', 'build_current', 'INTEGER');
  });
  // PD-910: live turn/token counts for the Audit agent's tile on the Agent Dashboard. The worker
  // writes these; it tolerates their absence, so either side can deploy first.
  migrate(db, 'audit_run_add_turns_tokens', (d) => {
    addColumn(d, 'audit_run', 'turns', 'INTEGER');
    addColumn(d, 'audit_run', 'tokens', 'INTEGER');
  });
  // PD-828: relation findings (link / unlink / duplicate). The audit now reads relations as truth
  // and may flag a new/stale link; a relation finding carries its other end + type. Both nullable
  // (NULL on a single-ticket finding), so every pre-existing finding back-fills cleanly. Advisory
  // only — the apply path that would write a relation is Child B (PD-287-blocked).
  migrate(db, 'audit_finding_add_relation_columns', (d) => {
    addColumn(d, 'audit_finding', 'target_ticket_id', 'INTEGER');
    addColumn(d, 'audit_finding', 'relation_type', 'TEXT');
  });
  // PD-285: cross-run reconciliation fingerprint on findings. Nullable, no back-fill — old rows
  // simply have no prior match (so they reset to 'undecided' next run, which is correct). The worker
  // writes it and tolerates its absence, so either side can deploy first. No-op on a fresh DB where
  // the CREATE above already included the column.
  migrate(db, 'audit_finding_add_fingerprint', (d) => {
    addColumn(d, 'audit_finding', 'fingerprint', 'TEXT');
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
  // D-058: `ready` (persisted 4-section shape check, recomputed on body write) + `ready_bypassed`
  // (human queued a not-Ready robot ticket via the confirm modal). Both default 0 so every
  // existing row back-fills to not-ready/not-bypassed; the queue-model migration below recomputes
  // `ready` from each row's body.
  migrate(db, 'agent_tickets_add_ready_fields', (d) => {
    addColumn(d, 'agent_tickets', 'ready', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(d, 'agent_tickets', 'ready_bypassed', 'INTEGER NOT NULL DEFAULT 0');
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

  // D-058 queue model: collapse the two queue lanes into one `queue` status and make `assignee`
  // the independent dispatch axis. `robot_queue` → `queue` + assignee `robot`; `steve_queue` →
  // `queue` + assignee `steve`. Then back-fill the persisted `ready` flag from every row's body
  // via the SAME shared 4-section `isReady` the store now recomputes on write. Data-only,
  // non-destructive; the status UPDATEs are naturally idempotent and the migrate ledger runs the
  // ready back-fill exactly once.
  // DEPLOY ORDER: the server (bootstrapSchema) MUST apply this BEFORE the agent-worker queries
  // `status='queue'`, or the loop greps a status no row carries yet (D-058: slices 1–3 deploy
  // atomically — no partial deploy where the server writes `queue` while the loop still greps
  // `robot_queue`).
  migrate(db, 'agent_tickets_queue_model_d058', (d) => {
    d.prepare("UPDATE agent_tickets SET status = 'queue', assignee = 'robot' WHERE status = 'robot_queue'").run();
    d.prepare("UPDATE agent_tickets SET status = 'queue', assignee = 'steve' WHERE status = 'steve_queue'").run();
    const rows = d.prepare('SELECT id, body FROM agent_tickets').all() as {
      id: number;
      body: string | null;
    }[];
    const setReady = d.prepare('UPDATE agent_tickets SET ready = ? WHERE id = ?');
    for (const r of rows) {
      setReady.run(isReady(r.body) ? 1 : 0, r.id);
    }
  });

  // D-080 part 1: the `prioritized` lane is retired and folds into `backlog`. The lane was never
  // carrying priority — it was carrying *commitment*, which D-080 re-expresses by queueing the
  // Epic. Naturally idempotent; runs after the D-040 collapse above, which is what created
  // `prioritized` rows in the first place.
  migrate(db, 'agent_tickets_retire_prioritized_lane', (d) => {
    d.prepare("UPDATE agent_tickets SET status = 'backlog' WHERE status = 'prioritized'").run();
  });

  // D-080 part 2: priority becomes an Epic property, cascaded to its members. Back-fills every
  // member's priority from its Epic so the column stops carrying two different meanings — a global
  // rank on some rows, an in-Epic rank on others (62 of 211 active members outranked their own
  // Epic when this was written).
  //
  // DEPLOY ORDER / DESTRUCTIVE: this OVERWRITES member priorities, so PD-507 (the Epic homogeneity
  // audit) must land first — an Epic whose members legitimately span priorities has to be split
  // before its distinctions are flattened. That is why PD-507 `blocks` PD-383.
  //
  // Epics with no priority set are deliberately SKIPPED rather than cascading 'none' downward:
  // wiping a member's real priority because nobody has classified its Epic yet would destroy
  // information to no purpose. Those rows keep what they have until the Epic is classified, at
  // which point the store's cascade-on-write picks them up.
  migrate(db, 'agent_tickets_priority_from_epic', (d) => {
    d.prepare(
      `UPDATE agent_tickets
          SET priority = (SELECT e.priority FROM agent_tickets e WHERE e.id = agent_tickets.epic_id)
        WHERE epic_id IS NOT NULL
          AND (SELECT e.priority FROM agent_tickets e WHERE e.id = agent_tickets.epic_id) != 'none'`,
    ).run();
  });

  // PD-432: per-ticket run ceiling. Nullable by design — NULL means "inherit the loop's env
  // default", so the global stays authoritative for the ~all tickets that never need an override.
  migrate(db, 'agent_tickets_add_max_turns', (d) => {
    addColumn(d, 'agent_tickets', 'max_turns', 'INTEGER');
  });

  // D-103 (PD-808): auto-queue exclusion. Meaningful on Epics — set by hand on Robot / Osiris / infra
  // Epics so the auto-queue promoter never auto-queues self-modifying work. Defaults 0 so every
  // existing row back-fills to "not excluded"; the member-level read checks its own Epic's column.
  migrate(db, 'agent_tickets_add_auto_queue_excluded', (d) => {
    addColumn(d, 'agent_tickets', 'auto_queue_excluded', 'INTEGER NOT NULL DEFAULT 0');
  });

  // PD-896: ticket kind (bug | feature | chore). Nullable — NULL is "unclassified", deliberately not
  // defaulted to `feature`, because the bug-rate metrics (PD-881) would read a guess as a fact.
  migrate(db, 'agent_tickets_add_kind', (d) => {
    addColumn(d, 'agent_tickets', 'kind', 'TEXT');
  });

  // PD-896: one-time seed of the existing bugs. Before the field existed a bug was only recognisable
  // by its title ("[bugfix]", "[Bug]", "bug -", "Bugfix regarding…"). See BUG_TITLE for what
  // counts; Epics are skipped (an umbrella is not itself a bug). Everything else is
  // left NULL rather than guessed. Runs once, so a later manual re-classification is never undone.
  migrate(db, 'agent_tickets_backfill_kind_bug', (d) => {
    const rows = d
      .prepare(`SELECT id, title FROM agent_tickets WHERE kind IS NULL AND is_epic = 0`)
      .all() as { id: number; title: string }[];
    const set = d.prepare(`UPDATE agent_tickets SET kind = 'bug' WHERE id = ?`);
    for (const r of rows) if (BUG_TITLE.test(r.title)) set.run(r.id);
  });

  // PD-880: Coder code-area subtype. Nullable — NULL means "unset", which `effectiveCoderArea`
  // resolves to the Epic's area and then to `general`, so no backfill is needed (the ticket says
  // none). Refine fills it in as tickets are refined; Steve can override it per ticket.
  migrate(db, 'agent_tickets_add_coder_area', (d) => {
    addColumn(d, 'agent_tickets', 'coder_area', 'TEXT');
  });

  // PD-610: the third refinement state. `refined = 0` otherwise means two different things — "never
  // refined", which is the ordinary condition of 78 of 80 Epics and must raise nothing, and "was
  // refined and its member set has changed since", which needs a warning. Existing rows default to
  // 0: nothing on the board has been through the new rule, so nothing is retroactively stale.
  migrate(db, 'agent_tickets_add_refine_stale', (d) => {
    addColumn(d, 'agent_tickets', 'refine_stale', 'INTEGER NOT NULL DEFAULT 0');
  });

  // PD-606: heal the rows that were left claiming a run they are not in.
  //
  // Three separate faults put tickets here, and the two write-side fixes (in `store.ts`) only stop
  // it happening again — neither reaches back. `reset` armed tickets that were not in the Queue;
  // `ready_bypassed` was never cleared on the way out; and PD-590's leaving-queue clear only ever
  // applied going forward, so anything already sitting in Backlog stayed that way permanently. On
  // 2026-08-31 that was PD-377 and PD-464, both reporting as live work for weeks.
  //
  // Scoped to `backlog` deliberately. It is the only non-Queue lane where these values are
  // meaningless: `completed` legitimately carries `agent_state = 'done'`, and a terminal ticket's
  // `ready_bypassed` is a true record that it WAS queued with an override — history, not a stale
  // flag. Terminal rows are read-only for exactly that reason (D-083).
  migrate(db, 'agent_tickets_clear_stale_run_state_in_backlog', (d) => {
    d.prepare(
      `UPDATE agent_tickets
          SET agent_state = NULL, ready_bypassed = 0
        WHERE status = 'backlog'
          AND archived_at IS NULL
          AND (agent_state IS NOT NULL OR ready_bypassed = 1)`,
    ).run();
  });

  // PD-888: record WHY a ticket was closed, so a SPLIT or SUPERSEDED close (which went through
  // Refine and has successors) is distinguishable from an abandoned one — both otherwise read
  // `closed`, `refined: false`. The column is nullable (NULL = plain/manual close or open).
  //
  // The back-fill reconstructs the reason for existing closed rows from the evidence already on the
  // board, and marks the split/superseded parents refined (they WERE refined — that is the whole
  // bug). Applied split → superseded → duplicate; every UPDATE is guarded `close_reason IS NULL`
  // (and the split/superseded ones `status = 'closed'`), so the precedence holds and re-running the
  // statements directly is a no-op on top of the migrate-ledger's run-once guarantee.
  migrate(db, 'agent_tickets_add_close_reason', (d) => {
    addColumn(d, 'agent_tickets', 'close_reason', 'TEXT');
    // Split parents: a closed ticket with an outgoing `split` relation (e.g. PD-455 → PD-874/PD-875).
    d.prepare(
      `UPDATE agent_tickets
          SET close_reason = 'split', refined = 1
        WHERE status = 'closed' AND close_reason IS NULL
          AND id IN (SELECT from_ticket_id FROM agent_ticket_relations WHERE type = 'split')`,
    ).run();
    // Superseded members: a ticket carrying a `refine_superseded` event (PD-931/PD-932).
    d.prepare(
      `UPDATE agent_tickets
          SET close_reason = 'superseded', refined = 1
        WHERE status = 'closed' AND close_reason IS NULL
          AND id IN (SELECT ticket_id FROM agent_ticket_events WHERE type = 'refine_superseded')`,
    ).run();
    // Duplicates: a closed ticket with an outgoing `duplicates` relation. Not marked refined — a
    // duplicate was never refined into successors, it was just a repeat.
    d.prepare(
      `UPDATE agent_tickets
          SET close_reason = 'duplicate'
        WHERE status = 'closed' AND close_reason IS NULL
          AND id IN (SELECT from_ticket_id FROM agent_ticket_relations WHERE type = 'duplicates')`,
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
