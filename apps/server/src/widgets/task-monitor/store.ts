import type Database from 'better-sqlite3';
import type {
  AgentNotification,
  AgentProject,
  AgentState,
  AgentTicket,
  CreateProjectInput,
  CreateTicketInput,
  LineageRef,
  NotificationKind,
  RefineCommitMode,
  EpicDerivedLane,
  EpicSummary,
  RelationOrigin,
  RelationType,
  ResolvedRelation,
  TicketRelation,
  TicketAssignee,
  TicketEvent,
  TicketLineage,
  TicketPriority,
  TicketStatus,
  UpdateTicketInput,
  WorkerHeartbeat,
  DispatchPauseState,
} from '@dashboard/shared';
import {
  isSortieReady,
  laneForcedAssignee,
  latestActionableProposal,
  refineStateFromLatestType,
  REFINE_EVENT_TYPE,
  REFINE_PROPOSAL_EVENT,
  ROBOT_EVENT,
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
  agent_state: string | null;
  refined: number;
  is_epic: number;
  epic_id: number | null;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
  /** Newest refine_* event type for this ticket, joined in by the list/get queries
   *  (absent on create/update returns → refineState is null there). */
  latest_refine_type?: string | null;
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
    assignee: row.assignee as AgentTicket['assignee'],
    recurInterval: row.recur_interval,
    source: row.source,
    sortOrder: row.sort_order,
    githubIssueNumber: row.github_issue_number,
    githubIssueUrl: row.github_issue_url,
    agentState: row.agent_state as AgentTicket['agentState'],
    refineState: refineStateFromLatestType(row.latest_refine_type),
    refined: row.refined === 1,
    isEpic: row.is_epic === 1,
    epicId: row.epic_id,
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

// Newest refine_* event type per ticket, so rowToTicket can derive refineState (D-044,
// PD-268) for the card/detail pill without an N+1 fetch. `t` is the agent_tickets alias.
const LATEST_REFINE_TYPE_SELECT = `(
  SELECT e.type FROM agent_ticket_events e
   WHERE e.ticket_id = t.id AND e.type IN ('refine_human', 'refine_agent')
   ORDER BY e.created_at DESC, e.id DESC LIMIT 1
) AS latest_refine_type`;

export function listTickets(db: Database.Database): AgentTicket[] {
  const rows = db
    .prepare(
      `SELECT t.*, ${LATEST_REFINE_TYPE_SELECT} FROM agent_tickets t
       WHERE archived_at IS NULL
       ORDER BY
         CASE status
           WHEN 'backlog' THEN 0
           WHEN 'prioritized' THEN 1
           WHEN 'robot_queue' THEN 2
           WHEN 'steve_queue' THEN 3
           WHEN 'completed' THEN 4
           WHEN 'closed' THEN 5
           ELSE 6
         END,
         sort_order ASC,
         id ASC`,
    )
    .all() as TicketRow[];
  return rows.map(rowToTicket);
}

export function getTicket(db: Database.Database, id: number): AgentTicket | null {
  const row = db
    .prepare(`SELECT t.*, ${LATEST_REFINE_TYPE_SELECT} FROM agent_tickets t WHERE t.id = ?`)
    .get(id) as TicketRow | undefined;
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
    // D-044: a queue lane forces its assignee on entry, overriding any hint the
    // caller passed; non-queue lanes keep the requested value (a free hint / null).
    const requestedAssignee: TicketAssignee | null =
      input.assignee === undefined ? null : input.assignee;
    const assignee: TicketAssignee | null = laneForcedAssignee(status) ?? requestedAssignee;
    // D-054: an Epic never nests (its own epic_id stays null) and can never be created into
    // robot_queue; a member's epic_id is validated against the target Epic.
    const isEpic = input.isEpic === true;
    const epicId = isEpic ? null : (input.epicId ?? null);
    if (isEpic && status === 'robot_queue') {
      throw new EpicGuardError('EPIC_NOT_QUEUEABLE', 'an Epic cannot enter robot_queue');
    }
    validateEpicMembership(db, { epicId, projectId: input.projectId });
    const result = db
      .prepare(
        `INSERT INTO agent_tickets (display_id, title, body, status, priority, project_id, assignee, recur_interval, source, sort_order, is_epic, epic_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(displayId, input.title, input.body ?? null, status, priority, input.projectId, assignee, input.recurInterval ?? null, source, now, isEpic ? 1 : 0, epicId, now, now);
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
    assignee: patch.assignee === undefined ? existing.assignee : patch.assignee,
    sortOrder: patch.sortOrder ?? existing.sortOrder,
    projectId: patch.projectId ?? existing.projectId,
    // `null` is meaningful (unlink), so distinguish it from "not provided".
    githubIssueNumber:
      patch.githubIssueNumber === undefined ? existing.githubIssueNumber : patch.githubIssueNumber,
    githubIssueUrl:
      patch.githubIssueUrl === undefined ? existing.githubIssueUrl : patch.githubIssueUrl,
    refined: patch.refined === undefined ? existing.refined : patch.refined,
    isEpic: patch.isEpic === undefined ? existing.isEpic : patch.isEpic,
    // `null` is meaningful (leave/clear the Epic); distinguish it from "not provided".
    epicId: patch.epicId === undefined ? existing.epicId : patch.epicId,
    updatedAt: Date.now(),
  };

  // D-054 epic invariants. An Epic never nests (its own epic_id is forced null) and can never
  // enter robot_queue; a member's epic_id is validated against the target Epic.
  if (next.isEpic) next.epicId = null;
  if (next.isEpic && next.status === 'robot_queue') {
    throw new EpicGuardError('EPIC_NOT_QUEUEABLE', 'an Epic cannot enter robot_queue');
  }
  // Un-flagging an Epic that still owns members would orphan their epic_id — refuse it.
  if (existing.isEpic && !next.isEpic && epicMemberCount(db, id) > 0) {
    throw new EpicGuardError('HAS_MEMBERS', 'unlink or archive the Epic members before un-flagging it');
  }
  if (next.epicId !== existing.epicId || next.isEpic !== existing.isEpic) {
    validateEpicMembership(db, { epicId: next.epicId, projectId: next.projectId, selfId: id });
  }

  // D-044: entering a queue lane forces the matching assignee, overriding any prior
  // value or hint — so "queued = assigned" holds regardless of who writes (the
  // agent-worker, a manual board drag, the API). Non-queue lanes leave assignee as set above.
  const forcedAssignee = laneForcedAssignee(next.status);
  if (forcedAssignee !== null) {
    next.assignee = forcedAssignee;
  }

  // Blocker gate (D-048): a ticket cannot ENTER robot_queue while it has unresolved blockers —
  // a second queue-entry precondition beside isSortieReady. Entry-only: an already-queued ticket
  // that later gains a blocker is not evicted here (PD-322's confirm covers that at add time).
  if (next.status === 'robot_queue' && existing.status !== 'robot_queue') {
    const blockers = unresolvedBlockers(db, id);
    if (blockers.length > 0) throw new QueueBlockedError(blockers);
  }

  const apply = db.transaction(() => {
    db.prepare(
      `UPDATE agent_tickets
       SET title = ?, body = ?, status = ?, priority = ?, sort_order = ?, project_id = ?, assignee = ?, github_issue_number = ?, github_issue_url = ?, refined = ?, is_epic = ?, epic_id = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      next.title,
      next.body,
      next.status,
      toDbPriority(next.priority),
      next.sortOrder,
      next.projectId,
      next.assignee,
      next.githubIssueNumber,
      next.githubIssueUrl,
      next.refined ? 1 : 0,
      next.isEpic ? 1 : 0,
      next.epicId,
      next.updatedAt,
      id,
    );
    if (next.status !== existing.status) {
      logEvent(db, id, 'status_changed', { from: existing.status, to: next.status });
    }
    // Covers both an explicit assignee change and a lane-forced one (D-044).
    if (next.assignee !== existing.assignee) {
      logEvent(db, id, 'assignee_changed', { from: existing.assignee, to: next.assignee });
    }
    // Recurrence: completing a ticket with a recur_interval spawns the next occurrence.
    if (
      next.status === 'completed' &&
      existing.status !== 'completed' &&
      existing.recurInterval != null &&
      existing.projectId !== null
    ) {
      const spawned = createTicket(db, {
        title: existing.title,
        body: existing.body,
        priority: existing.priority,
        projectId: existing.projectId,
        assignee: existing.assignee,
        recurInterval: existing.recurInterval,
        source: 'recur',
        status: 'backlog',
      });
      logEvent(db, id, 'recurred', { spawnedId: spawned.id, spawnedDisplayId: spawned.displayId });
    }
  });
  apply();

  return next;
}

/** A ticket linked to a GitHub issue, paired with its project's repo — the poller's input. */
export interface SyncTarget {
  id: number;
  githubIssueNumber: number;
  githubRepo: string;
  status: TicketStatus;
  agentState: AgentState | null;
}

/**
 * Active, GitHub-linked tickets whose project has a repo — the set the PD-165
 * poller reconciles against GitHub labels. Manual/unlinked tickets are excluded
 * so the poller never touches hand-managed lanes.
 */
export function listSyncTargets(db: Database.Database): SyncTarget[] {
  const rows = db
    .prepare(
      `SELECT t.id AS id, t.github_issue_number AS n, t.status AS status,
              t.agent_state AS agent_state, p.github_repo AS repo
         FROM agent_tickets t
         JOIN agent_projects p ON p.id = t.project_id
        WHERE t.archived_at IS NULL
          AND t.github_issue_number IS NOT NULL
          AND p.github_repo IS NOT NULL`,
    )
    .all() as { id: number; n: number; status: string; agent_state: string | null; repo: string }[];
  return rows.map((r) => ({
    id: r.id,
    githubIssueNumber: r.n,
    githubRepo: r.repo,
    status: r.status as TicketStatus,
    agentState: r.agent_state as AgentState | null,
  }));
}

/**
 * Write a GitHub-derived (status, agentState, assignee) onto a ticket. Poller-only:
 * unlike `updateTicket` it also sets `agent_state`, and it's a no-op (returns false)
 * when nothing changed, so an unchanged poll writes nothing and logs no event.
 * `assignee` is optional — when absent, the ticket's assignee is left alone, EXCEPT
 * that a queue-lane target still forces its assignee (D-044): entering `robot_queue`/
 * `steve_queue` sets robot/steve even when the derived rule carries no assignee (e.g.
 * the `sortie:in-review` label), so the poller can't leave a queue lane mis-assigned.
 */
export function applyDerivedState(
  db: Database.Database,
  id: number,
  status: TicketStatus,
  agentState: AgentState | null,
  assignee?: TicketAssignee,
): boolean {
  const existing = getTicket(db, id);
  if (!existing) return false;
  // Lane wins; else the derived assignee; else undefined = leave alone.
  const effectiveAssignee = laneForcedAssignee(status) ?? assignee;
  const assigneeChanged = effectiveAssignee !== undefined && existing.assignee !== effectiveAssignee;
  if (existing.status === status && existing.agentState === agentState && !assigneeChanged) return false;
  const now = Date.now();
  const apply = db.transaction(() => {
    if (assigneeChanged) {
      db.prepare(
        'UPDATE agent_tickets SET status = ?, agent_state = ?, assignee = ?, updated_at = ? WHERE id = ?',
      ).run(status, agentState, effectiveAssignee, now, id);
      logEvent(db, id, 'assignee_changed', { from: existing.assignee, to: effectiveAssignee, via: 'github-sync' });
    } else {
      db.prepare(
        'UPDATE agent_tickets SET status = ?, agent_state = ?, updated_at = ? WHERE id = ?',
      ).run(status, agentState, now, id);
    }
    if (existing.status !== status) {
      logEvent(db, id, 'status_changed', { from: existing.status, to: status, via: 'github-sync' });
    }
  });
  apply();
  return true;
}

/** A ticket in the `robot_queue` lane whose project is sortie-enabled with a repo — the
 *  input for the board→GitHub queued-issue sync (PD-164). `githubIssueNumber` is null
 *  when no issue has been created/linked yet. */
export interface QueuedIssueTarget {
  id: number;
  githubIssueNumber: number | null;
  githubRepo: string;
  title: string;
  body: string | null;
}

/**
 * Tickets currently in `robot_queue` (the D-040 dispatch lane), in a sortie-enabled
 * project with a repo — both already-linked and not-yet-linked. PD-164 ensures each has
 * a `sortie:queued` GitHub issue (creating + linking one when absent). Entering
 * `robot_queue` is therefore the dispatch trigger.
 */
export function listQueuedIssueTargets(db: Database.Database): QueuedIssueTarget[] {
  const rows = db
    .prepare(
      `SELECT t.id AS id, t.github_issue_number AS n, t.title AS title, t.body AS body, p.github_repo AS repo
         FROM agent_tickets t
         JOIN agent_projects p ON p.id = t.project_id
        WHERE t.archived_at IS NULL
          AND t.status = 'robot_queue'
          AND p.sortie_enabled = 1
          AND p.github_repo IS NOT NULL`,
    )
    .all() as { id: number; n: number | null; title: string; body: string | null; repo: string }[];
  return rows.map((r) => ({
    id: r.id,
    githubIssueNumber: r.n,
    githubRepo: r.repo,
    title: r.title,
    body: r.body,
  }));
}

/** A ticket's linked issue number + its project's repo — the close-on-delete input (PD-207 A). */
export interface TicketIssueRef {
  githubIssueNumber: number | null;
  githubRepo: string | null;
}

/**
 * The linked-issue reference for one ticket: its `githubIssueNumber` and the project's
 * `github_repo`. Returns null when the ticket doesn't exist. Either field may be null
 * (unlinked ticket, or a project with no repo) — close-on-delete only fires when both
 * are present.
 */
export function getTicketIssueRef(db: Database.Database, id: number): TicketIssueRef | null {
  const row = db
    .prepare(
      `SELECT t.github_issue_number AS n, p.github_repo AS repo
         FROM agent_tickets t
         LEFT JOIN agent_projects p ON p.id = t.project_id
        WHERE t.id = ?`,
    )
    .get(id) as { n: number | null; repo: string | null } | undefined;
  return row ? { githubIssueNumber: row.n, githubRepo: row.repo } : null;
}

/** Soft-delete: hide from the board but keep the row (recoverable). For an Epic (D-054), the
 *  caller chooses what happens to its members: `cascadeMembers` archives them too, otherwise they
 *  are unlinked (`epic_id` → null) and survive as free tickets. No-op for a non-epic. */
export function archiveTicket(
  db: Database.Database,
  id: number,
  opts: { cascadeMembers?: boolean } = {},
): boolean {
  const existing = getTicket(db, id);
  if (!existing || existing.archivedAt !== null) return false;
  const now = Date.now();
  const apply = db.transaction(() => {
    if (existing.isEpic) {
      const members = db
        .prepare('SELECT id FROM agent_tickets WHERE epic_id = ? AND archived_at IS NULL')
        .all(id) as { id: number }[];
      for (const m of members) {
        if (opts.cascadeMembers) {
          db.prepare('UPDATE agent_tickets SET archived_at = ?, updated_at = ? WHERE id = ?').run(now, now, m.id);
          logEvent(db, m.id, 'archived', { viaEpic: id });
        } else {
          db.prepare('UPDATE agent_tickets SET epic_id = NULL, updated_at = ? WHERE id = ?').run(now, m.id);
          logEvent(db, m.id, 'epic_unlinked', { epicId: id });
        }
      }
    }
    db.prepare('UPDATE agent_tickets SET archived_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
    logEvent(db, id, 'archived');
  });
  apply();
  return true;
}

/* ── Epics (D-054, PD-336) ───────────────────────────────────────────── */

/** An Epic invariant was violated (D-054). `code` maps to the HTTP status in routes. */
export class EpicGuardError extends Error {
  constructor(
    public readonly code:
      | 'NESTING'
      | 'NOT_AN_EPIC'
      | 'CROSS_PROJECT'
      | 'EPIC_NOT_FOUND'
      | 'EPIC_NOT_QUEUEABLE'
      | 'HAS_MEMBERS',
    message: string,
  ) {
    super(message);
    this.name = 'EpicGuardError';
  }
}

/** Validate a member's `epic_id` (D-054): the target must exist, be an Epic, share the member's
 *  project, and not be the member itself. No-op when `epicId` is null. */
export function validateEpicMembership(
  db: Database.Database,
  m: { epicId: number | null; projectId: number | null; selfId?: number },
): void {
  if (m.epicId == null) return;
  if (m.selfId != null && m.epicId === m.selfId) {
    throw new EpicGuardError('NESTING', 'a ticket cannot be its own Epic');
  }
  const target = db
    .prepare('SELECT is_epic, project_id, archived_at FROM agent_tickets WHERE id = ?')
    .get(m.epicId) as { is_epic: number; project_id: number | null; archived_at: number | null } | undefined;
  if (!target || target.archived_at !== null) {
    throw new EpicGuardError('EPIC_NOT_FOUND', `epic ${m.epicId} not found`);
  }
  if (target.is_epic !== 1) {
    throw new EpicGuardError('NOT_AN_EPIC', `ticket ${m.epicId} is not an Epic`);
  }
  if (target.project_id !== m.projectId) {
    throw new EpicGuardError('CROSS_PROJECT', "a member must share its Epic's project");
  }
}

/** Count an Epic's live members. */
export function epicMemberCount(db: Database.Database, epicId: number): number {
  const r = db
    .prepare('SELECT COUNT(*) AS n FROM agent_tickets WHERE epic_id = ? AND archived_at IS NULL')
    .get(epicId) as { n: number };
  return r.n;
}

/** An Epic's live member Tickets (D-054), ordered like the board. */
export function listEpicMembers(db: Database.Database, epicId: number): AgentTicket[] {
  const rows = db
    .prepare(
      `SELECT t.*, ${LATEST_REFINE_TYPE_SELECT} FROM agent_tickets t
        WHERE t.epic_id = ? AND t.archived_at IS NULL
        ORDER BY t.sort_order ASC, t.id ASC`,
    )
    .all(epicId) as TicketRow[];
  return rows.map(rowToTicket);
}

/** Derive an Epic's board lane from its members (D-054). With no members, fall back to the Epic's
 *  own hand-set status (an Epic can never be `robot_queue`, so a queue status → in_progress). */
function deriveEpicLane(memberStatuses: TicketStatus[], ownStatus: TicketStatus): EpicDerivedLane {
  if (memberStatuses.length === 0) {
    switch (ownStatus) {
      case 'robot_queue':
      case 'steve_queue':
        return 'in_progress';
      case 'completed':
        return 'completed';
      case 'closed':
        return 'closed';
      case 'prioritized':
        return 'prioritized';
      default:
        return 'backlog';
    }
  }
  if (memberStatuses.some((s) => s === 'robot_queue' || s === 'steve_queue')) return 'in_progress';
  const allDone = memberStatuses.every((s) => s === 'completed' || s === 'closed');
  if (allDone) return memberStatuses.some((s) => s === 'completed') ? 'completed' : 'closed';
  // Nobody in a queue, not all done → least-advanced pending lane.
  return memberStatuses.some((s) => s === 'backlog') ? 'backlog' : 'prioritized';
}

/** Roll-up + derived lane for a single Epic (D-054). */
export function computeEpicSummary(db: Database.Database, epicId: number): EpicSummary {
  const epic = db.prepare('SELECT status FROM agent_tickets WHERE id = ?').get(epicId) as
    | { status: string }
    | undefined;
  const rows = db
    .prepare('SELECT status FROM agent_tickets WHERE epic_id = ? AND archived_at IS NULL')
    .all(epicId) as { status: string }[];
  const statuses = rows.map((r) => r.status as TicketStatus);
  const done = statuses.filter((s) => s === 'completed' || s === 'closed').length;
  return {
    ticketId: epicId,
    done,
    total: statuses.length,
    derivedLane: deriveEpicLane(statuses, (epic?.status ?? 'backlog') as TicketStatus),
  };
}

/** Roll-ups for every live Epic — the bulk read the board fetches alongside tickets (D-054). */
export function listEpicSummaries(db: Database.Database): EpicSummary[] {
  const epics = db
    .prepare('SELECT id FROM agent_tickets WHERE is_epic = 1 AND archived_at IS NULL')
    .all() as { id: number }[];
  return epics.map((e) => computeEpicSummary(db, e.id));
}

/* ── Ticket activity log + Refine thread (D-044, PD-267) ─────────────── */

interface TicketEventRow {
  id: number;
  ticket_id: number;
  type: string;
  detail: string | null;
  created_at: number;
}

function rowToTicketEvent(row: TicketEventRow): TicketEvent {
  let detail: unknown = null;
  if (row.detail != null) {
    try {
      detail = JSON.parse(row.detail);
    } catch {
      // Legacy/plain-text detail — surface it raw rather than dropping the row.
      detail = row.detail;
    }
  }
  return { id: row.id, ticketId: row.ticket_id, type: row.type, detail, createdAt: row.created_at };
}

/** A ticket's full activity log, oldest first (the generic substrate PD-255 renders; the
 *  Refine thread is the `refine_*` subset). Returns [] for an unknown ticket. */
export function listTicketEvents(db: Database.Database, ticketId: number): TicketEvent[] {
  const rows = db
    .prepare(
      'SELECT id, ticket_id, type, detail, created_at FROM agent_ticket_events WHERE ticket_id = ? ORDER BY created_at ASC, id ASC',
    )
    .all(ticketId) as TicketEventRow[];
  return rows.map(rowToTicketEvent);
}

/** Outcome of a startRefine attempt: the kickoff event, or a reason it didn't start. */
export type StartRefineResult =
  | { ok: true; event: TicketEvent }
  | { ok: false; reason: 'not_found' | 'already_started' };

/**
 * Start a Refine session on a ticket (D-044, PD-268). The DB is the queue: this writes the
 * KICKOFF `refine_human` event (the ticket's title + body) that the agent-worker's poll loop
 * consumes to open a grounded session. No-op-safe: returns `already_started` if the ticket
 * already has any refine_* turn, so a double-click can't spawn a second thread.
 */
export function startRefine(db: Database.Database, ticketId: number): StartRefineResult {
  const ticket = getTicket(db, ticketId);
  if (ticket === null) return { ok: false, reason: 'not_found' };

  const existing = db
    .prepare(
      `SELECT 1 FROM agent_ticket_events WHERE ticket_id = ? AND type IN (?, ?) LIMIT 1`,
    )
    .get(ticketId, REFINE_EVENT_TYPE.human, REFINE_EVENT_TYPE.agent);
  if (existing) return { ok: false, reason: 'already_started' };

  const kickoff = [ticket.title, ticket.body ?? ''].join('\n\n').trim();
  const now = Date.now();
  const res = db
    .prepare('INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)')
    .run(ticketId, REFINE_EVENT_TYPE.human, JSON.stringify({ text: kickoff }), now);
  const row = db
    .prepare('SELECT id, ticket_id, type, detail, created_at FROM agent_ticket_events WHERE id = ?')
    .get(Number(res.lastInsertRowid)) as TicketEventRow;
  return { ok: true, event: rowToTicketEvent(row) };
}

/**
 * Append a human Refine turn (Steve's reply) as a `refine_human` event the agent-worker
 * consumes on its next poll. Returns the created event, or null if the ticket is unknown.
 * This is the Refine reply path — distinct from the GitHub-issue `/reply` (PD-250), which
 * re-queues a parked Sortie agent; a Refine reply stays entirely in the DB.
 */
export function appendRefineReply(
  db: Database.Database,
  ticketId: number,
  text: string,
): TicketEvent | null {
  if (getTicket(db, ticketId) === null) return null;
  const now = Date.now();
  const res = db
    .prepare('INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)')
    .run(ticketId, REFINE_EVENT_TYPE.human, JSON.stringify({ text }), now);
  const row = db
    .prepare('SELECT id, ticket_id, type, detail, created_at FROM agent_ticket_events WHERE id = ?')
    .get(Number(res.lastInsertRowid)) as TicketEventRow | undefined;
  return row ? rowToTicketEvent(row) : null;
}

/* ── Ticket relations + Refine commit (D-020 table, D-044/PD-269, D-048) ────── */

/** A `blocks` relation would create a cycle (D-048) — refused so the hard queue-entry gate can
 *  never deadlock. `path` is the existing dependency chain the new edge would close, as ticket ids. */
export class RelationCycleError extends Error {
  constructor(public readonly path: number[]) {
    super(`relation would create a blocks cycle: ${path.join(' → ')}`);
    this.name = 'RelationCycleError';
  }
}

/** A ticket cannot relate to itself (D-048). */
export class SelfRelationError extends Error {
  constructor() {
    super('a ticket cannot relate to itself');
    this.name = 'SelfRelationError';
  }
}

/** The blocker gate (D-048): a ticket cannot enter `robot_queue` while it has unresolved
 *  blockers. Thrown from `updateTicket`; the PATCH route maps it to 409. */
export class QueueBlockedError extends Error {
  constructor(public readonly blockers: LineageRef[]) {
    super(`blocked by unresolved: ${blockers.map((b) => b.displayId ?? b.ticketId).join(', ')}`);
    this.name = 'QueueBlockedError';
  }
}

/** A blocker is "resolved" (stops gating) once it is terminal — completed / closed / archived
 *  (D-048). The four active lanes still block. Used by the gate and by `unresolvedBlockers`. */
const UNRESOLVED_BLOCKER_SQL =
  "t.status NOT IN ('completed', 'closed') AND t.archived_at IS NULL";

/** The ticket's incoming `blocks` relations whose blocker is not yet resolved. Empty ⇒ the
 *  blocker gate is clear. */
export function unresolvedBlockers(db: Database.Database, ticketId: number): LineageRef[] {
  const rows = db
    .prepare(
      `SELECT t.id AS oid, t.display_id, t.title, t.status
         FROM agent_ticket_relations r JOIN agent_tickets t ON t.id = r.from_ticket_id
        WHERE r.to_ticket_id = ? AND r.type = 'blocks' AND ${UNRESOLVED_BLOCKER_SQL}
        ORDER BY t.id ASC`,
    )
    .all(ticketId) as { oid: number; display_id: string | null; title: string; status: string }[];
  return rows.map((r) => ({
    ticketId: r.oid,
    displayId: r.display_id,
    title: r.title,
    status: r.status as TicketStatus,
  }));
}

/** Adding "blocked = blocker" (row from=blocker, to=blocked) means `blocked` now depends on
 *  `blocker`. That closes a cycle iff `blocker` already transitively depends on `blocked`.
 *  A ticket's dependencies are the `from` sides of its incoming `blocks` rows. Returns the
 *  dependency path `[blocker, …, blocked]` if one exists, else null. */
function findBlocksDependencyPath(
  db: Database.Database,
  blockerId: number,
  blockedId: number,
): number[] | null {
  const deps = db.prepare(
    "SELECT from_ticket_id AS dep FROM agent_ticket_relations WHERE to_ticket_id = ? AND type = 'blocks'",
  );
  const stack: number[][] = [[blockerId]];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const path = stack.pop() as number[];
    const node = path[path.length - 1];
    if (node === blockedId) return path;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const { dep } of deps.all(node) as { dep: number }[]) {
      stack.push([...path, dep]);
    }
  }
  return null;
}

/**
 * Link two tickets (idempotent via the UNIQUE(from,to,type) constraint). Direction is
 * `from = source, to = target`; for `blocks`, `from = blocker, to = blocked` (D-048).
 * Rejects self-relations (all types) and, for `blocks`, any edge that would close a cycle.
 * `origin` defaults to `'agent'` so the griller/audit callers need no change; the relations
 * UI passes `'human'`. Returns the relation id (existing id if the row was already present).
 */
export function addRelation(
  db: Database.Database,
  fromTicketId: number,
  toTicketId: number,
  type: RelationType,
  origin: RelationOrigin = 'agent',
): number {
  if (fromTicketId === toTicketId) throw new SelfRelationError();
  if (type === 'blocks') {
    const path = findBlocksDependencyPath(db, fromTicketId, toTicketId);
    if (path !== null) throw new RelationCycleError([...path, fromTicketId]);
  }
  db.prepare(
    'INSERT OR IGNORE INTO agent_ticket_relations (from_ticket_id, to_ticket_id, type, origin, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(fromTicketId, toTicketId, type, origin, Date.now());
  const row = db
    .prepare(
      'SELECT id FROM agent_ticket_relations WHERE from_ticket_id = ? AND to_ticket_id = ? AND type = ?',
    )
    .get(fromTicketId, toTicketId, type) as { id: number } | undefined;
  return row?.id ?? 0;
}

/** Remove a relation by its row id (the relations UI's per-row remove, PD-322). Returns true
 *  if a row was deleted. */
export function removeRelationById(db: Database.Database, relationId: number): boolean {
  const res = db.prepare('DELETE FROM agent_ticket_relations WHERE id = ?').run(relationId);
  return res.changes > 0;
}

interface RelationJoinRow {
  id: number;
  type: string;
  origin: string;
  created_at: number;
  oid: number;
  display_id: string | null;
  title: string;
  status: string;
}

/** Remove a link (the UNLINK primitive; PD-288's audit Reject/undo path). No-op if absent. */
export function removeRelation(
  db: Database.Database,
  fromTicketId: number,
  toTicketId: number,
  type: RelationType,
): void {
  db.prepare(
    'DELETE FROM agent_ticket_relations WHERE from_ticket_id = ? AND to_ticket_id = ? AND type = ?',
  ).run(fromTicketId, toTicketId, type);
}

/** Every relation touching a ticket, both directions, resolved to the other end. Consumers that
 *  treat relations as truth (the Ticket Audit, PD-288) read this to avoid re-proposing existing
 *  links. Unlike getLineage this is type-agnostic (blocks/split/relates/duplicates). */
export function listRelations(db: Database.Database, ticketId: number): ResolvedRelation[] {
  const outgoing = db
    .prepare(
      `SELECT r.id, r.type, r.origin, r.created_at, t.id AS oid, t.display_id, t.title, t.status
         FROM agent_ticket_relations r JOIN agent_tickets t ON t.id = r.to_ticket_id
        WHERE r.from_ticket_id = ?`,
    )
    .all(ticketId) as RelationJoinRow[];
  const incoming = db
    .prepare(
      `SELECT r.id, r.type, r.origin, r.created_at, t.id AS oid, t.display_id, t.title, t.status
         FROM agent_ticket_relations r JOIN agent_tickets t ON t.id = r.from_ticket_id
        WHERE r.to_ticket_id = ?`,
    )
    .all(ticketId) as RelationJoinRow[];
  const rel = (row: RelationJoinRow, direction: 'from' | 'to'): ResolvedRelation => ({
    id: row.id,
    type: row.type as RelationType,
    origin: row.origin as RelationOrigin,
    direction,
    other: {
      ticketId: row.oid,
      displayId: row.display_id,
      title: row.title,
      status: row.status as TicketStatus,
    },
    createdAt: row.created_at,
  });
  return [...outgoing.map((r) => rel(r, 'from')), ...incoming.map((r) => rel(r, 'to'))].sort(
    (a, b) => a.createdAt - b.createdAt || a.id - b.id,
  );
}

/** Every relation on the board as raw rows (PD-322). Sparse in practice, so the board fetches
 *  this once and resolves each card's badges against tickets it already holds in memory — cheaper
 *  than one `listRelations` call per card. */
export function listAllRelations(db: Database.Database): TicketRelation[] {
  const rows = db
    .prepare(
      `SELECT id, from_ticket_id, to_ticket_id, type, origin, created_at
         FROM agent_ticket_relations ORDER BY id ASC`,
    )
    .all() as {
    id: number;
    from_ticket_id: number;
    to_ticket_id: number;
    type: string;
    origin: string;
    created_at: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    fromTicketId: r.from_ticket_id,
    toTicketId: r.to_ticket_id,
    type: r.type as RelationType,
    origin: r.origin as RelationOrigin,
    createdAt: r.created_at,
  }));
}

/** A ticket's split lineage for the read-only display (PD-269); PD-156 owns the full UI. */
export function getLineage(db: Database.Database, ticketId: number): TicketLineage {
  const intoRows = db
    .prepare(
      `SELECT t.id, t.display_id, t.title, t.status
         FROM agent_ticket_relations r JOIN agent_tickets t ON t.id = r.to_ticket_id
        WHERE r.from_ticket_id = ? AND r.type = 'split'
        ORDER BY t.id ASC`,
    )
    .all(ticketId) as { id: number; display_id: string | null; title: string; status: string }[];
  const fromRows = db
    .prepare(
      `SELECT t.id, t.display_id, t.title, t.status
         FROM agent_ticket_relations r JOIN agent_tickets t ON t.id = r.from_ticket_id
        WHERE r.to_ticket_id = ? AND r.type = 'split'
        ORDER BY t.id ASC`,
    )
    .all(ticketId) as { id: number; display_id: string | null; title: string; status: string }[];
  const map = (r: { id: number; display_id: string | null; title: string; status: string }) => ({
    ticketId: r.id,
    displayId: r.display_id,
    title: r.title,
    status: r.status as TicketStatus,
  });
  return { splitInto: intoRows.map(map), splitFrom: fromRows.map(map) };
}

/** Write a proposal-lifecycle event (committed / rejected). */
function logProposalEvent(db: Database.Database, ticketId: number, type: string, detail: unknown): void {
  db.prepare(
    'INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)',
  ).run(ticketId, type, JSON.stringify(detail), Date.now());
}

export type ApproveRefineResult =
  | { ok: true; mode: RefineCommitMode; refinedTicketId?: number; childIds?: number[] }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'no_proposal'
        | 'invalid_proposal'
        | 'child_not_sortie_ready'
        | 'blocked_by_unresolved';
      detail?: string;
    };

/**
 * Execute the latest actionable commit proposal on Steve's approval (D-044, PD-269). The
 * agent-worker only proposes; this is the single place tickets are written, so the lane→assignee
 * invariant + isSortieReady gate are enforced here. Refine-in-place rewrites the ticket and
 * marks it refined; decompose creates routed children, closes the parent (D-036), and links
 * each child via a `split` relation. All-or-nothing (one transaction); validation runs first.
 */
export function approveRefine(db: Database.Database, ticketId: number): ApproveRefineResult {
  const parent = getTicket(db, ticketId);
  if (!parent) return { ok: false, reason: 'not_found' };

  const found = latestActionableProposal(listTicketEvents(db, ticketId));
  if (!found) return { ok: false, reason: 'no_proposal' };
  const p = found.proposal;

  if (p.mode === 'refine_in_place') {
    const status = p.status ?? parent.status;
    const body = p.body ?? parent.body;
    if (status === 'robot_queue' && !isSortieReady(body)) {
      return { ok: false, reason: 'child_not_sortie_ready', detail: parent.displayId ?? String(ticketId) };
    }
    // Blocker gate (D-048): pre-check here so approveRefine keeps its no-throw contract rather
    // than letting updateTicket's QueueBlockedError escape the transaction.
    if (status === 'robot_queue' && parent.status !== 'robot_queue') {
      const blockers = unresolvedBlockers(db, ticketId);
      if (blockers.length > 0) {
        return {
          ok: false,
          reason: 'blocked_by_unresolved',
          detail: blockers.map((b) => b.displayId ?? String(b.ticketId)).join(', '),
        };
      }
    }
    const run = db.transaction(() => {
      updateTicket(db, ticketId, {
        body,
        status,
        assignee: p.assignee === undefined ? parent.assignee : p.assignee,
        priority: p.priority === undefined ? parent.priority : p.priority,
        refined: true,
      });
      logProposalEvent(db, ticketId, REFINE_PROPOSAL_EVENT.committed, { mode: p.mode });
    });
    run();
    return { ok: true, mode: p.mode, refinedTicketId: ticketId };
  }

  // decompose
  // D-054: decompose closes the parent (D-036) — nonsensical for an Epic umbrella, which must
  // stay open to hold its members. Populate an Epic via membership, not by decomposing it.
  if (parent.isEpic) {
    return { ok: false, reason: 'invalid_proposal', detail: 'cannot decompose an Epic' };
  }
  const children = p.children ?? [];
  if (children.length === 0) return { ok: false, reason: 'invalid_proposal', detail: 'no children' };
  if (parent.projectId === null) {
    return { ok: false, reason: 'invalid_proposal', detail: 'parent has no project' };
  }
  const projectId = parent.projectId;
  // Validate ALL robot-bound children before any write.
  for (const c of children) {
    if (c.status === 'robot_queue' && !isSortieReady(c.body)) {
      return { ok: false, reason: 'child_not_sortie_ready', detail: c.title };
    }
  }
  const childIds: number[] = [];
  const run = db.transaction(() => {
    for (const c of children) {
      const child = createTicket(db, {
        title: c.title,
        body: c.body,
        status: c.status,
        assignee: c.assignee ?? undefined,
        priority: c.priority ?? null,
        projectId,
        // D-054 split-inheritance: children stay under the parent's Epic (if any).
        epicId: parent.epicId,
      });
      addRelation(db, ticketId, child.id, 'split');
      childIds.push(child.id);
    }
    updateTicket(db, ticketId, { status: 'closed' });
    logProposalEvent(db, ticketId, REFINE_PROPOSAL_EVENT.committed, { mode: p.mode, childIds });
  });
  run();
  return { ok: true, mode: p.mode, childIds };
}

export type RejectRefineResult = { ok: true } | { ok: false; reason: 'not_found' | 'no_proposal' };

/** Drop the latest actionable proposal (Steve rejected); the grill can propose again. */
export function rejectRefine(db: Database.Database, ticketId: number): RejectRefineResult {
  if (getTicket(db, ticketId) === null) return { ok: false, reason: 'not_found' };
  const found = latestActionableProposal(listTicketEvents(db, ticketId));
  if (!found) return { ok: false, reason: 'no_proposal' };
  logProposalEvent(db, ticketId, REFINE_PROPOSAL_EVENT.rejected, { eventId: found.eventId });
  return { ok: true };
}

/* ── Notifications (Notification Center, D-040) ─────────────────────── */

interface NotificationRow {
  id: number;
  kind: string;
  ticket_id: number | null;
  title: string;
  body: string | null;
  read_at: number | null;
  created_at: number;
  display_id: string | null; // joined from agent_tickets
}

function rowToNotification(row: NotificationRow): AgentNotification {
  return {
    id: row.id,
    kind: row.kind as NotificationKind,
    ticketId: row.ticket_id,
    ticketDisplayId: row.display_id,
    title: row.title,
    body: row.body,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

const NOTIFICATION_SELECT = `
  SELECT n.id, n.kind, n.ticket_id, n.title, n.body, n.read_at, n.created_at,
         t.display_id AS display_id
    FROM agent_notifications n
    LEFT JOIN agent_tickets t ON t.id = n.ticket_id`;

export interface CreateNotificationInput {
  kind: NotificationKind;
  ticketId?: number | null;
  title: string;
  body?: string | null;
}

/**
 * Create a notification. Dedup guard: when ticket-scoped, if the same (ticketId, kind)
 * already has an UNREAD notification we skip and return null — so a parked ticket the
 * poller sees every minute is not re-notified until the human reads/acts on it.
 */
export function createNotification(
  db: Database.Database,
  input: CreateNotificationInput,
): AgentNotification | null {
  if (input.ticketId != null) {
    const dup = db
      .prepare('SELECT 1 FROM agent_notifications WHERE ticket_id = ? AND kind = ? AND read_at IS NULL')
      .get(input.ticketId, input.kind);
    if (dup) return null;
  }
  const now = Date.now();
  const res = db
    .prepare('INSERT INTO agent_notifications (kind, ticket_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(input.kind, input.ticketId ?? null, input.title, input.body ?? null, now);
  const row = db.prepare(`${NOTIFICATION_SELECT} WHERE n.id = ?`).get(Number(res.lastInsertRowid)) as
    | NotificationRow
    | undefined;
  return row ? rowToNotification(row) : null;
}

/** Newest first. `unreadOnly` limits to unread; `limit` caps the row count (for the
 *  nav dropdown — the full-history page omits it). */
export function listNotifications(
  db: Database.Database,
  opts: { unreadOnly?: boolean; limit?: number } = {},
): AgentNotification[] {
  const where = opts.unreadOnly ? 'WHERE n.read_at IS NULL' : '';
  // limit is coerced to a non-negative integer, so it's safe to inline.
  const limit =
    opts.limit != null && Number.isFinite(opts.limit)
      ? ` LIMIT ${Math.max(0, Math.floor(opts.limit))}`
      : '';
  const rows = db
    .prepare(`${NOTIFICATION_SELECT} ${where} ORDER BY n.created_at DESC, n.id DESC${limit}`)
    .all() as NotificationRow[];
  return rows.map(rowToNotification);
}

export function unreadNotificationCount(db: Database.Database): number {
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM agent_notifications WHERE read_at IS NULL')
    .get() as { c: number };
  return row.c;
}

/** Mark one notification read (idempotent). Returns false only when the id doesn't exist. */
export function markNotificationRead(db: Database.Database, id: number): boolean {
  const res = db
    .prepare('UPDATE agent_notifications SET read_at = COALESCE(read_at, ?) WHERE id = ?')
    .run(Date.now(), id);
  return res.changes > 0;
}

/** Mark all unread notifications read; returns how many were flipped. */
export function markAllNotificationsRead(db: Database.Database): number {
  const res = db
    .prepare('UPDATE agent_notifications SET read_at = ? WHERE read_at IS NULL')
    .run(Date.now());
  return res.changes;
}

// ── System status (Site Status section) ──────────────────────────────────────

interface WorkerHeartbeatRow {
  worker: string;
  started_at: number;
  last_seen: number;
  pid: number | null;
  sha: string | null;
  model: string | null;
}

/** Count active (non-archived) tickets by Sortie `agent_state`. Only states that
 *  actually occur appear in the map — a state with zero tickets is simply absent.
 *  Pure aggregation over existing rows; no new data source. */
export function getSortieFleet(db: Database.Database): Partial<Record<AgentState, number>> {
  const rows = db
    .prepare(
      `SELECT agent_state AS state, COUNT(*) AS n
         FROM agent_tickets
        WHERE archived_at IS NULL AND agent_state IS NOT NULL
        GROUP BY agent_state`,
    )
    .all() as { state: string; n: number }[];
  const out: Partial<Record<AgentState, number>> = {};
  for (const r of rows) out[r.state as AgentState] = r.n;
  return out;
}

/** The Robot loop's global dispatch-pause flag (C2/PD-343), read from the worker-owned
 *  `robot_state` k/v table in the same shared DB. Set when a system-wide (auth/credit)
 *  fault is detected; cleared by a human (C4). Absent table / row ⇒ running. Read-only. */
export function getDispatchPauseState(db: Database.Database): DispatchPauseState {
  const row = (() => {
    try {
      return db.prepare("SELECT value, updated_at FROM robot_state WHERE key = 'dispatch_paused'").get() as
        | { value: string | null; updated_at: number }
        | undefined;
    } catch {
      // robot_state not bootstrapped yet (worker never booted) ⇒ treat as running.
      return undefined;
    }
  })();
  if (!row || row.value === null) return { paused: false, reason: null, since: null };
  return { paused: true, reason: row.value, since: row.updated_at };
}

/** Ensure the worker-owned `robot_state` table exists before the server writes it — the server may
 *  set the pause flag (C4 manual pause) before the worker has ever booted. Mirrors the worker's DDL. */
function ensureRobotStateTable(db: Database.Database): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS robot_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL)',
  );
}

/** Human pause/resume of Robot dispatch (C4/PD-345). Unlike the worker's auto-pause (which keeps
 *  the first fault reason), a human action overwrites unconditionally: Pause sets the flag with a
 *  human reason, Resume clears it. The loop honors the flag on its next poll. */
export function setDispatchPaused(
  db: Database.Database,
  paused: boolean,
  reason: string | null = null,
  now: number = Date.now(),
): DispatchPauseState {
  ensureRobotStateTable(db);
  db.prepare(
    `INSERT INTO robot_state (key, value, updated_at) VALUES ('dispatch_paused', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(paused ? (reason ?? 'paused by human') : null, now);
  return getDispatchPauseState(db);
}

export type RobotResetKind = 'reset' | 'unstick';

/** Human per-ticket remediation (C4/PD-345). Writes a `robot_reset`/`robot_unstick` event — the
 *  boundary the loop counts retries from, so the ticket's transient budget is cleared without
 *  destroying its run history (C3) — and sets `agent_state = queued` so the loop re-dispatches it
 *  on its next poll. Returns the updated ticket, or null if it doesn't exist. */
export function resetRobotRuns(
  db: Database.Database,
  ticketId: number,
  kind: RobotResetKind,
  now: number = Date.now(),
): AgentTicket | null {
  const ticket = getTicket(db, ticketId);
  if (!ticket) return null;
  const type = kind === 'unstick' ? ROBOT_EVENT.unstick : ROBOT_EVENT.reset;
  logEvent(db, ticketId, type, { reason: kind === 'unstick' ? 'unstuck by human' : 'reset by human' });
  db.prepare('UPDATE agent_tickets SET agent_state = ?, updated_at = ? WHERE id = ?').run('queued', now, ticketId);
  return getTicket(db, ticketId);
}

/** Every known worker heartbeat, freshest first. The web server never talks to a
 *  worker directly — this row (upserted by the worker) is the liveness signal. */
export function listWorkerHeartbeats(db: Database.Database): WorkerHeartbeat[] {
  const rows = db
    .prepare('SELECT * FROM worker_heartbeat ORDER BY last_seen DESC')
    .all() as WorkerHeartbeatRow[];
  return rows.map((r) => ({
    worker: r.worker,
    startedAt: r.started_at,
    lastSeen: r.last_seen,
    pid: r.pid,
    sha: r.sha,
    model: r.model,
  }));
}
