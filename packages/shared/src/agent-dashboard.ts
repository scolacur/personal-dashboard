// Types for the Agent Dashboard "Tasks" Kanban — the project's TODO backlog.
// Shared between the server (DB + API) and the web (Kanban UI).

// The five Kanban columns. Backlog/ready are set by hand; the agent statuses
// (in_progress/in_review/completed) are derived from GitHub once a TODO has been
// converted to a Sortie issue (Phase 3) — see DECISIONS.md D-018.
export type TodoStatus = 'backlog' | 'ready' | 'in_progress' | 'in_review' | 'completed';

export type TodoPriority = 'low' | 'medium' | 'high';

export const TODO_STATUSES: readonly TodoStatus[] = [
  'backlog',
  'ready',
  'in_progress',
  'in_review',
  'completed',
] as const;

export const TODO_PRIORITIES: readonly TodoPriority[] = ['low', 'medium', 'high'] as const;

// A project the TODOs belong to (personal-dashboard, core, nervous-system-website, …).
// The dashboard tracks TODOs across all projects, not just itself.
export interface AgentProject {
  id: number;
  slug: string;
  name: string;
  /** Display-id prefix, e.g. 'PD' → tickets are PD-1, PD-2, … */
  key: string | null;
  /** 'owner/repo' for Phase-3 issue creation; null if the project isn't on GitHub. */
  githubRepo: string | null;
  /** Whether "Convert to Sortie issue" applies to this project. */
  sortieEnabled: boolean;
  /** Hex color for the project chip on cards. */
  color: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateProjectInput {
  slug: string;
  name: string;
  githubRepo?: string | null;
  sortieEnabled?: boolean;
  color?: string | null;
}

export interface AgentTodo {
  id: number;
  /** Human-facing per-project id, e.g. 'PD-7'. Null only for legacy rows. */
  displayId: string | null;
  title: string;
  body: string | null;
  status: TodoStatus;
  priority: TodoPriority;
  /** The project this TODO belongs to. */
  projectId: number | null;
  /** Human or agent (e.g. 'sortie') that owns the ticket. */
  assignee: string | null;
  /** Recurrence hint for maintenance tickets, e.g. 'weekly'. */
  recurInterval: string | null;
  /** 'manual' or 'todo.md:<path>' once Phase 2 seed-import lands. */
  source: string;
  /** Ordering within a column (ascending); fractional to allow drag-reorder. */
  sortOrder: number;
  /** Set when the TODO is converted to a GitHub issue (Phase 3). */
  githubIssueNumber: number | null;
  githubIssueUrl: string | null;
  /** Soft-delete timestamp; null = active. */
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Fields accepted when creating a TODO. New items land in `backlog`. */
export interface CreateTodoInput {
  title: string;
  projectId: number;
  body?: string | null;
  priority?: TodoPriority;
}

/** Partial update — any subset of these fields. */
export interface UpdateTodoInput {
  title?: string;
  body?: string | null;
  status?: TodoStatus;
  priority?: TodoPriority;
  sortOrder?: number;
  projectId?: number;
}
