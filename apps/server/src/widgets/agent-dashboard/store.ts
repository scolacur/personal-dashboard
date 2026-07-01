import type Database from 'better-sqlite3';
import type {
  AgentProject,
  AgentTodo,
  CreateProjectInput,
  CreateTodoInput,
  TodoPriority,
  UpdateTodoInput,
} from '@dashboard/shared';

// Raw DB rows (snake_case). Mapped to camelCase at this boundary so the API and UI
// never see snake_case (PROJECT.md §5: typed helpers, no raw SQL in routes).
interface TodoRow {
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

function rowToTodo(row: TodoRow): AgentTodo {
  return {
    id: row.id,
    displayId: row.display_id,
    title: row.title,
    body: row.body,
    status: row.status as AgentTodo['status'],
    priority: row.priority as TodoPriority,
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
function logEvent(db: Database.Database, todoId: number, type: string, detail?: unknown): void {
  db.prepare('INSERT INTO agent_todo_events (todo_id, type, detail, created_at) VALUES (?, ?, ?, ?)').run(
    todoId,
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

/* ── Todos ────────────────────────────────────── */

export function listTodos(db: Database.Database): AgentTodo[] {
  const rows = db
    .prepare(
      `SELECT * FROM agent_todos
       WHERE archived_at IS NULL
       ORDER BY
         CASE status
           WHEN 'backlog' THEN 0
           WHEN 'ready' THEN 1
           WHEN 'in_progress' THEN 2
           WHEN 'in_review' THEN 3
           WHEN 'completed' THEN 4
           ELSE 5
         END,
         sort_order ASC,
         id ASC`,
    )
    .all() as TodoRow[];
  return rows.map(rowToTodo);
}

export function getTodo(db: Database.Database, id: number): AgentTodo | null {
  const row = db.prepare('SELECT * FROM agent_todos WHERE id = ?').get(id) as TodoRow | undefined;
  return row ? rowToTodo(row) : null;
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

export function createTodo(db: Database.Database, input: CreateTodoInput): AgentTodo {
  const insert = db.transaction((): number => {
    const now = Date.now();
    const priority: TodoPriority = input.priority ?? 'medium';
    const displayId = nextDisplayId(db, input.projectId);
    const result = db
      .prepare(
        `INSERT INTO agent_todos (display_id, title, body, status, priority, project_id, source, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, 'backlog', ?, ?, 'manual', ?, ?, ?)`,
      )
      .run(displayId, input.title, input.body ?? null, priority, input.projectId, now, now, now);
    const id = Number(result.lastInsertRowid);
    logEvent(db, id, 'created');
    return id;
  });
  const created = getTodo(db, insert());
  if (!created) throw new Error('Failed to read back created todo');
  return created;
}

export function updateTodo(
  db: Database.Database,
  id: number,
  patch: UpdateTodoInput,
): AgentTodo | null {
  const existing = getTodo(db, id);
  if (!existing) return null;

  const next: AgentTodo = {
    ...existing,
    title: patch.title ?? existing.title,
    body: patch.body === undefined ? existing.body : patch.body,
    status: patch.status ?? existing.status,
    priority: patch.priority ?? existing.priority,
    sortOrder: patch.sortOrder ?? existing.sortOrder,
    projectId: patch.projectId ?? existing.projectId,
    updatedAt: Date.now(),
  };

  const apply = db.transaction(() => {
    db.prepare(
      `UPDATE agent_todos
       SET title = ?, body = ?, status = ?, priority = ?, sort_order = ?, project_id = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      next.title,
      next.body,
      next.status,
      next.priority,
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
export function archiveTodo(db: Database.Database, id: number): boolean {
  const existing = getTodo(db, id);
  if (!existing || existing.archivedAt !== null) return false;
  const now = Date.now();
  const apply = db.transaction(() => {
    db.prepare('UPDATE agent_todos SET archived_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
    logEvent(db, id, 'archived');
  });
  apply();
  return true;
}
