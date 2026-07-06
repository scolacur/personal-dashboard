import type Database from 'better-sqlite3';
import type {
  AgentNotification,
  AgentProject,
  AgentState,
  AgentTicket,
  CreateProjectInput,
  CreateTicketInput,
  NotificationKind,
  RefineCommitMode,
  RelationType,
  TicketAssignee,
  TicketEvent,
  TicketLineage,
  TicketPriority,
  TicketStatus,
  UpdateTicketInput,
} from '@dashboard/shared';
import {
  isSortieReady,
  laneForcedAssignee,
  latestActionableProposal,
  refineStateFromLatestType,
  REFINE_EVENT_TYPE,
  REFINE_PROPOSAL_EVENT,
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
    const result = db
      .prepare(
        `INSERT INTO agent_tickets (display_id, title, body, status, priority, project_id, assignee, source, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(displayId, input.title, input.body ?? null, status, priority, input.projectId, assignee, source, now, now, now);
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
    updatedAt: Date.now(),
  };

  // D-044: entering a queue lane forces the matching assignee, overriding any prior
  // value or hint — so "queued = assigned" holds regardless of who writes (the
  // griller, a manual board drag, the API). Non-queue lanes leave assignee as set above.
  const forcedAssignee = laneForcedAssignee(next.status);
  if (forcedAssignee !== null) {
    next.assignee = forcedAssignee;
  }

  const apply = db.transaction(() => {
    db.prepare(
      `UPDATE agent_tickets
       SET title = ?, body = ?, status = ?, priority = ?, sort_order = ?, project_id = ?, assignee = ?, github_issue_number = ?, github_issue_url = ?, refined = ?, updated_at = ?
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
 * KICKOFF `refine_human` event (the ticket's title + body) that the griller's poll loop
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
 * Append a human Refine turn (Steve's reply) as a `refine_human` event the griller
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

/* ── Ticket relations + Refine commit (D-020 table, D-044/PD-269) ────── */

/** Link two tickets (idempotent via the UNIQUE(from,to,type) constraint). */
export function addRelation(
  db: Database.Database,
  fromTicketId: number,
  toTicketId: number,
  type: RelationType,
): void {
  db.prepare(
    'INSERT OR IGNORE INTO agent_ticket_relations (from_ticket_id, to_ticket_id, type, created_at) VALUES (?, ?, ?, ?)',
  ).run(fromTicketId, toTicketId, type, Date.now());
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
      reason: 'not_found' | 'no_proposal' | 'invalid_proposal' | 'child_not_sortie_ready';
      detail?: string;
    };

/**
 * Execute the latest actionable commit proposal on Steve's approval (D-044, PD-269). The
 * griller only proposes; this is the single place tickets are written, so the lane→assignee
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
    const run = db.transaction(() => {
      updateTicket(db, ticketId, {
        body,
        status,
        assignee: p.assignee === undefined ? parent.assignee : p.assignee,
        refined: true,
      });
      logProposalEvent(db, ticketId, REFINE_PROPOSAL_EVENT.committed, { mode: p.mode });
    });
    run();
    return { ok: true, mode: p.mode, refinedTicketId: ticketId };
  }

  // decompose
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
        projectId,
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
