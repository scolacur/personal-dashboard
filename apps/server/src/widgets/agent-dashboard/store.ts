import type Database from 'better-sqlite3';
import type {
  AgentProject,
  AgentTicket,
  CreateProjectInput,
  CreateTicketInput,
  TicketPriority,
  TicketStatus,
  UpdateTicketInput,
} from '@dashboard/shared';

// Raw DB rows (snake_case). Mapped to camelCase at this boundary so the API and UI
// never see snake_case (PROJECT.md §5: typed helpers, no raw SQL in routes).
interface TicketRow {
  id: number;
  display_id: string | null;
  title: string;
  body: string | null;
  status: string;
  priority: string;
  project_id: number | null;
  assignee: string | null;
  recur_interval: string | null;
  source: string;
  sort_order: number;
  github_issue_number: number | null;
  github_issue_url: string | null;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

interface ProjectRow {
  id: number;
  slug: string;
  name: string;
  key: string | null;
  seq: number;
  github_repo: string | null;
  sortie_enabled: number;
  color: string | null;
  created_at: number;
  updated_at: number;
}

// Priority is nullable in the domain (unset), but the DB column is NOT NULL, so
// "unset" is stored as the sentinel 'none'. Map across that boundary here.
const PRIORITY_UNSET = 'none';
function toDbPriority(p: TicketPriority | null | undefined): string {
  return p ?? PRIORITY_UNSET;
}
function fromDbPriority(s: string): TicketPriority | null {
  return s === PRIORITY_UNSET ? null : (s as TicketPriority);
}

function rowToTicket(row: TicketRow): AgentTicket {
  return {
    id: row.id,
    displayId: row.display_id,
    title: row.title,
    body: row.body,
    status: row.status as AgentTicket['status'],
    priority: fromDbPriority(row.priority),
    projectId: row.project_id,
    assignee: row.assignee,
    recurInterval: row.recur_interval,
    source: row.source,
    sortOrder: row.sort_order,
    githubIssueNumber: row.github_issue_number,
    githubIssueUrl: row.github_issue_url,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToProject(row: ProjectRow): AgentProject {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    key: row.key,
    githubRepo: row.github_repo,
    sortieEnabled: row.sortie_enabled === 1,
    color: row.color,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Append an activity-log entry. `detail` is any JSON-serialisable value. */
function logEvent(db: Database.Database, ticketId: number, type: string, detail?: unknown): void {
  db.prepare('INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)').run(
    ticketId,
    type,
    detail === undefined ? null : JSON.stringify(detail),
    Date.now(),
  );
}

/* ── Projects ─────────────────────────────────── */

export function listProjects(db: Database.Database): AgentProject[] {
  const rows = db.prepare('SELECT * FROM agent_projects ORDER BY name ASC').all() as ProjectRow[];
  return rows.map(rowToProject);
}

export function projectExists(db: Database.Database, id: number): boolean {
  return db.prepare('SELECT 1 FROM agent_projects WHERE id = ?').get(id) !== undefined;
}

export function getProjectBySlug(db: Database.Database, slug: string): AgentProject | null {
  const row = db.prepare('SELECT * FROM agent_projects WHERE slug = ?').get(slug) as
    | ProjectRow
    | undefined;
  return row ? rowToProject(row) : null;
}

export function createProject(db: Database.Database, input: CreateProjectInput): AgentProject {
  const now = Date.now();
  const result = db
    .prepare(
      `INSERT INTO agent_projects (slug, name, github_repo, sortie_enabled, color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.slug,
      input.name,
      input.githubRepo ?? null,
      input.sortieEnabled ? 1 : 0,
      input.color ?? null,
      now,
      now,
    );
  const row = db
    .prepare('SELECT * FROM agent_projects WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as ProjectRow;
  return rowToProject(row);
}

/* ── Tickets ────────────────────────────────────── */

export function listTickets(db: Database.Database): AgentTicket[] {
  const rows = db
    .prepare(
      `SELECT * FROM agent_tickets
       WHERE archived_at IS NULL
       ORDER BY
         CASE status
           WHEN 'backlog' THEN 0
           WHEN 'ready' THEN 1
           WHEN 'queued' THEN 2
           WHEN 'in_progress' THEN 3
           WHEN 'in_review' THEN 4
           WHEN 'completed' THEN 5
           ELSE 6
         END,
         sort_order ASC,
         id ASC`,
    )
    .all() as TicketRow[];
  return rows.map(rowToTicket);
}

export function getTicket(db: Database.Database, id: number): AgentTicket | null {
  const row = db.prepare('SELECT * FROM agent_tickets WHERE id = ?').get(id) as TicketRow | undefined;
  return row ? rowToTicket(row) : null;
}

/** Allocate the next per-project display id (e.g. 'PD-7'), bumping the project's counter. */
function nextDisplayId(db: Database.Database, projectId: number): string {
  const proj = db.prepare('SELECT key, seq FROM agent_projects WHERE id = ?').get(projectId) as
    | { key: string | null; seq: number }
    | undefined;
  const prefix = proj?.key ?? 'T';
  const seq = (proj?.seq ?? 0) + 1;
  db.prepare('UPDATE agent_projects SET seq = ?, updated_at = ? WHERE id = ?').run(
    seq,
    Date.now(),
    projectId,
  );
  return `${prefix}-${seq}`;
}

export function createTicket(db: Database.Database, input: CreateTicketInput): AgentTicket {
  const insert = db.transaction((): number => {
    const now = Date.now();
    // New tickets default to unset priority (the user assigns it deliberately).
    const priority = toDbPriority(input.priority ?? null);
    const status: TicketStatus = input.status ?? 'backlog';
    const source = input.source ?? 'manual';
    // Seed restores can force an id; otherwise allocate the next per-project id.
    // When forced, advance the project's seq past it so future auto-ids don't collide.
    let displayId: string;
    if (input.displayId) {
      displayId = input.displayId;
      const n = Number(/(\d+)$/.exec(input.displayId)?.[1]);
      if (Number.isFinite(n)) {
        db.prepare('UPDATE agent_projects SET seq = MAX(seq, ?), updated_at = ? WHERE id = ?').run(
          n,
          now,
          input.projectId,
        );
      }
    } else {
      displayId = nextDisplayId(db, input.projectId);
    }
    const result = db
      .prepare(
        `INSERT INTO agent_tickets (display_id, title, body, status, priority, project_id, source, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(displayId, input.title, input.body ?? null, status, priority, input.projectId, source, now, now, now);
    const id = Number(result.lastInsertRowid);
    logEvent(db, id, 'created');
    return id;
  });
  const created = getTicket(db, insert());
  if (!created) throw new Error('Failed to read back created ticket');
  return created;
}

/** True if a ticket with this provenance + title already exists (import idempotency). */
export function ticketExistsBySource(db: Database.Database, source: string, title: string): boolean {
  return (
    db.prepare('SELECT 1 FROM agent_tickets WHERE source = ? AND title = ?').get(source, title) !==
    undefined
  );
}

export function updateTicket(
  db: Database.Database,
  id: number,
  patch: UpdateTicketInput,
): AgentTicket | null {
  const existing = getTicket(db, id);
  if (!existing) return null;

  const next: AgentTicket = {
    ...existing,
    title: patch.title ?? existing.title,
    body: patch.body === undefined ? existing.body : patch.body,
    status: patch.status ?? existing.status,
    // `null` is a meaningful value (unset), so distinguish it from "not provided".
    priority: patch.priority === undefined ? existing.priority : patch.priority,
    sortOrder: patch.sortOrder ?? existing.sortOrder,
    projectId: patch.projectId ?? existing.projectId,
    updatedAt: Date.now(),
  };

  const apply = db.transaction(() => {
    db.prepare(
      `UPDATE agent_tickets
       SET title = ?, body = ?, status = ?, priority = ?, sort_order = ?, project_id = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      next.title,
      next.body,
      next.status,
      toDbPriority(next.priority),
      next.sortOrder,
      next.projectId,
      next.updatedAt,
      id,
    );
    if (next.status !== existing.status) {
      logEvent(db, id, 'status_changed', { from: existing.status, to: next.status });
    }
  });
  apply();

  return next;
}

/** Soft-delete: hide from the board but keep the row (recoverable). */
export function archiveTicket(db: Database.Database, id: number): boolean {
  const existing = getTicket(db, id);
  if (!existing || existing.archivedAt !== null) return false;
  const now = Date.now();
  const apply = db.transaction(() => {
    db.prepare('UPDATE agent_tickets SET archived_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
    logEvent(db, id, 'archived');
  });
  apply();
  return true;
}
