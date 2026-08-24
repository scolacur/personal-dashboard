import type Database from 'better-sqlite3';
import type {
  AgentNotification,
  AgentProject,
  AgentState,
  NeedsHumanTicket,
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
  SessionLimitHoldState,
  GithubRateLimitStatus,
  RobotBudgetStatus,
} from '@dashboard/shared';
import {
  coerceTicketStatus,
  isReady,
  latestActionableProposal,
  refineStateFromLatestType,
  REFINE_EVENT_TYPE,
  REFINE_PROPOSAL_EVENT,
  ROBOT_EVENT,
  ROBOT_MAX_TURNS_LIMIT,
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
  ready: number;
  ready_bypassed: number;
  max_turns: number | null;
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
  robot_enabled: number;
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

function rowToTicket(row: TicketRow, agentTurns: number | null = null): AgentTicket {
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
    // PD-230: turns of the ticket's latest Robot run; joined separately (see latestRunTurns).
    agentTurns,
    // PD-400: a terminal ticket carries no live refine session — never project a
    // refining/awaiting-human pill on a completed/closed ticket, regardless of its last refine_*
    // event. (agent_state is cleared as a real write on the terminal transition; refineState is
    // purely derived, so guarding it here also covers tickets closed before this landed.)
    refineState:
      row.status === 'completed' || row.status === 'closed'
        ? null
        : refineStateFromLatestType(row.latest_refine_type),
    refined: row.refined === 1,
    ready: row.ready === 1,
    readyBypassed: row.ready_bypassed === 1,
    maxTurns: row.max_turns,
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
    robotEnabled: row.robot_enabled === 1,
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
      `INSERT INTO agent_projects (slug, name, github_repo, robot_enabled, color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.slug,
      input.name,
      input.githubRepo ?? null,
      input.robotEnabled ? 1 : 0,
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

/**
 * Turns used by each ticket's LATEST Robot run (PD-230), keyed by ticket id.
 *
 * Deliberately a SEPARATE guarded query rather than a subselect in the ticket queries: the
 * agent-worker OWNS `agent_runs` and creates it, so on a fresh volume where the worker has never
 * run the table does not exist — a subselect would 500 the whole board. Mirrors the same guard on
 * `listRunsForTicket` (runs-store.ts). One query for the board, not N+1.
 */
function latestRunTurns(db: Database.Database, ticketId?: number): Map<number, number> {
  const byTicket = new Map<number, number>();
  try {
    const sql =
      `SELECT ticket_id, turns FROM agent_runs` +
      (ticketId === undefined ? '' : ' WHERE ticket_id = ?') +
      ` ORDER BY ticket_id ASC, started_at DESC, id DESC`;
    const stmt = db.prepare(sql);
    const rows = (ticketId === undefined ? stmt.all() : stmt.all(ticketId)) as {
      ticket_id: number;
      turns: number | null;
    }[];
    // Rows are newest-first within a ticket, so the FIRST row per ticket decides — including
    // deciding "no value". Tracked with a separate `seen` set on purpose: a just-started run has
    // turns=null, and falling through to an older row would report a stale count from the
    // PREVIOUS attempt on a live card.
    const seen = new Set<number>();
    for (const r of rows) {
      if (seen.has(r.ticket_id)) continue;
      seen.add(r.ticket_id);
      if (typeof r.turns === 'number') byTicket.set(r.ticket_id, r.turns);
    }
  } catch {
    // `agent_runs` absent (worker never ran) — no turn data, board still renders.
  }
  return byTicket;
}

export function listTickets(db: Database.Database): AgentTicket[] {
  const rows = db
    .prepare(
      `SELECT t.*, ${LATEST_REFINE_TYPE_SELECT} FROM agent_tickets t
       WHERE archived_at IS NULL
       ORDER BY
         CASE status
           WHEN 'backlog' THEN 0
           WHEN 'prioritized' THEN 1
           WHEN 'queue' THEN 2
           WHEN 'completed' THEN 3
           WHEN 'closed' THEN 4
           ELSE 5
         END,
         sort_order ASC,
         id ASC`,
    )
    .all() as TicketRow[];
  const turns = latestRunTurns(db);
  return rows.map((row) => rowToTicket(row, turns.get(row.id) ?? null));
}

export function getTicket(db: Database.Database, id: number): AgentTicket | null {
  const row = db
    .prepare(`SELECT t.*, ${LATEST_REFINE_TYPE_SELECT} FROM agent_tickets t WHERE t.id = ?`)
    .get(id) as TicketRow | undefined;
  return row ? rowToTicket(row, latestRunTurns(db, id).get(id) ?? null) : null;
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

/** A write-boundary validation failure (D-058, PD-417) — e.g. a status outside `TICKET_STATUSES`
 *  that isn't a coercible legacy alias. Surfaced by the routes as a 400. */
export class ValidationError extends Error {
  constructor(
    public readonly code: 'INVALID_STATUS' | 'INVALID_MAX_TURNS',
    message: string,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Coerce a caller-supplied status to a valid lane, normalizing legacy `robot_queue`/`steve_queue`
 *  → `queue` (D-058, PD-417). Throws `ValidationError` on an unrecognized value so an invalid lane
 *  can never be persisted — the durable backstop for internal callers (e.g. `approveRefine`) that
 *  bypass the route-layer validation. */
function coerceStatusOrThrow(status: string): TicketStatus {
  const coerced = coerceTicketStatus(status);
  if (coerced === null) throw new ValidationError('INVALID_STATUS', `invalid status: ${status}`);
  return coerced;
}

/**
 * Validate a per-ticket run ceiling (PD-432). `null` clears the override (inherit the loop default).
 *
 * **Rejected, not clamped**, above `ROBOT_MAX_TURNS_LIMIT`: whoever set 5000 needs to learn the
 * ceiling exists — a silently-lowered value would look accepted and then behave as something else.
 * The override is the escape hatch for an irreducible ticket, not a way to authorise an unbounded
 * burn (a Refine estimate writes this field too, so it must hold against a bad guess).
 */
function validMaxTurns(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 1) {
    throw new ValidationError('INVALID_MAX_TURNS', 'maxTurns must be a positive whole number, or null');
  }
  if (value > ROBOT_MAX_TURNS_LIMIT) {
    throw new ValidationError('INVALID_MAX_TURNS', `maxTurns may not exceed ${ROBOT_MAX_TURNS_LIMIT}`);
  }
  return value;
}

export function createTicket(db: Database.Database, input: CreateTicketInput): AgentTicket {
  const insert = db.transaction((): number => {
    const now = Date.now();
    // New tickets default to unset priority (the user assigns it deliberately). D-TMP-PD383a may override
    // both of these below, once the target Epic is known.
    let priority = toDbPriority(input.priority ?? null);
    // D-058/PD-417: normalize legacy queue statuses + reject anything invalid at the write boundary.
    let status: TicketStatus = input.status === undefined ? 'backlog' : coerceStatusOrThrow(input.status);
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
    // D-058: assignee is a free axis — no lane forces it. Keep the requested value (a hint / null).
    const assignee: TicketAssignee | null =
      input.assignee === undefined ? null : input.assignee;
    // D-058: `ready` is computed from the body on every write and persisted (server-authoritative,
    // never client-set). A create always writes a body (possibly null), so always recompute.
    const readyFlag = isReady(input.body ?? null) ? 1 : 0;
    // D-054/D-058/D-TMP-PD383a: an Epic never nests (its own epic_id stays null); a member's epic_id is
    // validated against the target Epic. D-TMP-PD383a drops the "an Epic cannot be created into `queue`"
    // guard along with its update-path twin — an Epic in `queue` now means *active*.
    const isEpic = input.isEpic === true;
    const epicId = isEpic ? null : (input.epicId ?? null);
    validateEpicMembership(db, { epicId, projectId: input.projectId });

    // D-TMP-PD383a: a Ticket created into a queued Epic lands in `backlog`, never the active set. Without
    // this, anything able to add a member to a live Epic could create a dispatch — which would
    // reduce D-039 ("an autonomous agent may create into backlog only") from a structural guarantee
    // to a convention, recursively. Joining an in-flight Epic's work stays an explicit act.
    if (!isEpic && epicId !== null && status === 'queue') {
      status = 'backlog';
    }

    // D-TMP-PD383a: a member's priority is its Epic's. An unclassified Epic leaves the supplied value
    // alone, matching the back-fill migration and the update path.
    if (!isEpic && epicId !== null) {
      const inherited = epicPriorityOf(db, epicId);
      if (inherited !== null) priority = toDbPriority(inherited);
    }
    // PD-432: per-ticket run ceiling, validated at the write boundary (see `validMaxTurns`).
    const maxTurns = validMaxTurns(input.maxTurns ?? null);
    const result = db
      .prepare(
        `INSERT INTO agent_tickets (display_id, title, body, status, priority, project_id, assignee, recur_interval, source, sort_order, ready, max_turns, is_epic, epic_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(displayId, input.title, input.body ?? null, status, priority, input.projectId, assignee, input.recurInterval ?? null, source, now, readyFlag, maxTurns, isEpic ? 1 : 0, epicId, now, now);
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

  // D-058/PD-417: normalize a legacy `robot_queue`/`steve_queue` patch → `queue`, reject an invalid
  // status. Keeps a stale client / caller from writing an orphaned lane past the route validation.
  const patchedStatus = patch.status === undefined ? existing.status : coerceStatusOrThrow(patch.status);

  const next: AgentTicket = {
    ...existing,
    title: patch.title ?? existing.title,
    body: patch.body === undefined ? existing.body : patch.body,
    status: patchedStatus,
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
    // D-058: `ready` is server-computed from the body (recomputed below when body is in the patch),
    // never client-set. `readyBypassed` IS client-settable (the confirm-modal flag), defaults to
    // the existing value.
    ready: existing.ready,
    readyBypassed: patch.readyBypassed === undefined ? existing.readyBypassed : patch.readyBypassed,
    isEpic: patch.isEpic === undefined ? existing.isEpic : patch.isEpic,
    // PD-432: `null` is meaningful (clear the override, back to the loop default).
    maxTurns: patch.maxTurns === undefined ? existing.maxTurns : validMaxTurns(patch.maxTurns),
    // `null` is meaningful (leave/clear the Epic); distinguish it from "not provided".
    epicId: patch.epicId === undefined ? existing.epicId : patch.epicId,
    updatedAt: Date.now(),
  };

  // D-058: recompute `ready` whenever the body is written (create always; update when `body` is in
  // the patch). It always reflects the CURRENT body — editing a Ready ticket keeps it Ready as long
  // as the four sections survive, and drops it the instant one is lost. `ready_bypassed` is left as
  // set above (D-058: it goes moot once the body is fixed since the gate is `ready OR bypassed`).
  if (patch.body !== undefined) {
    next.ready = isReady(next.body);
  }

  // D-054/D-058/D-TMP-PD383a epic invariants. An Epic never nests (its own epic_id is forced null); a
  // member's epic_id is validated against the target Epic.
  //
  // **D-TMP-PD383a removes the "an Epic can never enter `queue`" guard.** Queueing the Epic *is* how work
  // is now dispatched — the Epic is the unit a human moves, and its members follow via the cascade
  // in the transaction below. The guard existed because only member Tickets are ever dispatched,
  // which is still true: an Epic in `queue` means *active*, not *dispatchable*, and the loop's
  // candidate query never selects an Epic row.
  if (next.isEpic) next.epicId = null;
  // Un-flagging an Epic that still owns members would orphan their epic_id — refuse it.
  if (existing.isEpic && !next.isEpic && epicMemberCount(db, id) > 0) {
    throw new EpicGuardError('HAS_MEMBERS', 'unlink or archive the Epic members before un-flagging it');
  }
  if (next.epicId !== existing.epicId || next.isEpic !== existing.isEpic) {
    validateEpicMembership(db, { epicId: next.epicId, projectId: next.projectId, selfId: id });
  }

  // D-058: assignee is a free axis — the lane no longer forces it (reverses D-044/D-055).
  // `next.assignee` is whatever the caller set (or the existing value); left untouched here.

  // D-TMP-PD383a: priority is an Epic property. A member's priority is not independently settable, so a
  // client-supplied value is silently overridden rather than rejected — the board sends whole-ticket
  // patches, and 400-ing them would break every edit that merely echoes the current priority back.
  // An unclassified Epic (`null`) leaves the member's value alone, matching the back-fill migration:
  // nothing is destroyed just because nobody has classified the Epic yet.
  if (!next.isEpic && next.epicId !== null) {
    const inherited = epicPriorityOf(db, next.epicId);
    if (inherited !== null) next.priority = inherited;
  }

  // Blocker gate (D-051, amended by PD-408): a blocked ticket MAY sit in `queue` — queue entry is no
  // longer refused. The single authoritative "never dispatch a blocked ticket" guard is the loop's
  // selection query (`robotQueueCandidates` in agent-worker `select.ts`, which excludes any ticket
  // with an open `blocks` blocker), mirrored read-side by the board's blocked badge. This lets a
  // whole decomposed chain (A blocks B blocks C) be queued at once and self-sequence: the loop runs
  // the unblocked head and auto-picks each next slice the cycle after its blocker goes terminal.

  // PD-400: manually moving a ticket to a terminal lane (`completed`/`closed`) ends any lingering
  // agent session cleanly — clear `agent_state`, resolve open needs/awaiting-human notifications,
  // and (via rowToTicket) stop projecting a refine pill. Reflect it in the returned object too so a
  // terminal ticket never carries a stale human-attention state.
  const enteringTerminal =
    (next.status === 'completed' || next.status === 'closed') &&
    existing.status !== 'completed' &&
    existing.status !== 'closed';
  if (enteringTerminal) {
    next.agentState = null;
    next.refineState = null;
  }

  // D-TMP-PD539a: the mirror image. `completeTicket` writes `agent_state = 'done'` alongside the
  // status, and `UpdateTicketInput` has no `agentState` field for a caller to clear — so a reopened
  // robot ticket would sit in Backlog still wearing a green "done" pill, and `robotQueueCandidates`
  // (which selects on `agent_state IS NULL OR 'queued'`) would never pick it up again. Leaving a
  // terminal lane clears it, so a reopened ticket is genuinely back in play rather than only
  // looking like it.
  const leavingTerminal =
    (existing.status === 'completed' || existing.status === 'closed') &&
    next.status !== 'completed' &&
    next.status !== 'closed';
  if (leavingTerminal) {
    next.agentState = null;
  }

  // PD-467: a ticket parked `stuck`/`needs-human` keeps that `agent_state` forever, and the loop's
  // selection gates on `agent_state IS NULL OR 'queued'` — so re-queueing a parked ticket from the
  // board produced a card that looked perfectly normal in the Queue and could NEVER dispatch, with
  // nothing saying so. (PD-426 sat in exactly this state.) Entering `queue` is an explicit human
  // "run this", so it clears the park itself rather than requiring the easy-to-miss Unstick control.
  //
  // `awaiting-human` is deliberately NOT cleared: it means an unanswered question, and clearing it
  // would re-dispatch the Robot to ask the same question again (the PD-393 failure). It is owned by
  // the reply → `resumeAskHuman` path; the loop's PD-467 warn log covers it if it ever sticks.
  const parkedOnQueueEntry =
    next.status === 'queue' &&
    existing.status !== 'queue' &&
    (existing.agentState === 'stuck' || existing.agentState === 'needs-human');
  if (parkedOnQueueEntry) {
    next.agentState = 'queued';
  }

  const apply = db.transaction(() => {
    db.prepare(
      `UPDATE agent_tickets
       SET title = ?, body = ?, status = ?, priority = ?, sort_order = ?, project_id = ?, assignee = ?, github_issue_number = ?, github_issue_url = ?, refined = ?, ready = ?, ready_bypassed = ?, max_turns = ?, is_epic = ?, epic_id = ?, updated_at = ?
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
      next.ready ? 1 : 0,
      next.readyBypassed ? 1 : 0,
      next.maxTurns,
      next.isEpic ? 1 : 0,
      next.epicId,
      next.updatedAt,
      id,
    );
    if (next.status !== existing.status) {
      logEvent(db, id, 'status_changed', { from: existing.status, to: next.status });
    }

    // ── D-TMP-PD383a: the Epic cascades to its members ──────────────────────────────
    // Both cascades run inside this transaction so a member can never be seen half-updated.
    if (next.isEpic) {
      // Priority. This is the whole point of Epic-owned priority: re-prioritise one Epic, not its
      // twelve members. A value copied at create time and never re-pushed would go stale on the
      // first re-prioritisation — i.e. the first time the model is used as intended.
      if (next.priority !== existing.priority && next.priority !== null) {
        db.prepare(
          'UPDATE agent_tickets SET priority = ?, updated_at = ? WHERE epic_id = ? AND archived_at IS NULL',
        ).run(toDbPriority(next.priority), next.updatedAt, id);
      }

      // Dispatch. Queueing the Epic arms every member that has not started; `completed`/`closed`
      // members are untouched, because a half-done Epic is the normal state of an in-flight Epic.
      if (next.status === 'queue' && existing.status !== 'queue') {
        db.prepare(
          `UPDATE agent_tickets SET status = 'queue', updated_at = ?
            WHERE epic_id = ? AND status = 'backlog' AND archived_at IS NULL`,
        ).run(next.updatedAt, id);
      }

      // Rollback. Un-queues only members that never started. A member with a live run is left in
      // the queue deliberately: killing a Robot mid-hand-off loses the work outright (D-046), so
      // ending a run is a separate, explicit act (the slice-B modal), never a side effect of a drag.
      if (existing.status === 'queue' && next.status === 'backlog') {
        db.prepare(
          `UPDATE agent_tickets SET status = 'backlog', updated_at = ?
            WHERE epic_id = ? AND status = 'queue' AND archived_at IS NULL
              AND (agent_state IS NULL OR agent_state = 'queued')`,
        ).run(next.updatedAt, id);
      }
    }
    // D-TMP-PD539a: clear the stale agent state on the way OUT of a terminal lane. `agent_state` is
    // not in the UPDATE above (it is loop-owned and absent from UpdateTicketInput), so — exactly
    // like the entering-terminal teardown below — it takes its own statement inside this
    // transaction rather than riding along on the main write.
    if (leavingTerminal && existing.agentState !== null) {
      db.prepare('UPDATE agent_tickets SET agent_state = NULL WHERE id = ?').run(id);
    }

    // PD-400: tear down a lingering agent session on the terminal transition. Idempotent — a
    // ticket that's already clean (no agent_state, no open notification, no active refine) logs
    // no `session_ended` event.
    if (enteringTerminal) {
      const hadAgentState = existing.agentState !== null;
      if (hadAgentState) {
        db.prepare('UPDATE agent_tickets SET agent_state = NULL WHERE id = ?').run(id);
      }
      const resolved = db
        .prepare(
          `UPDATE agent_notifications SET read_at = ?
             WHERE ticket_id = ? AND kind IN ('agent_needs_human', 'agent_awaiting_human') AND read_at IS NULL`,
        )
        .run(next.updatedAt, id);
      const endedRefine = existing.refineState !== null;
      if (hadAgentState || resolved.changes > 0 || endedRefine) {
        logEvent(db, id, ROBOT_EVENT.sessionEnded, {
          to: next.status,
          clearedAgentState: existing.agentState ?? undefined,
          resolvedNotifications: resolved.changes || undefined,
          endedRefine: endedRefine || undefined,
        });
      }
    }
    // PD-467: write the cleared state, and log it as an `unstick` — the SAME event the human
    // control writes, because that event is also the loop's retry-budget boundary
    // (`resetBoundaryForTicket`). Logging anything else would hand the ticket back to the loop with
    // its exhausted budget intact, so it would dispatch once and immediately re-park at the cap.
    if (parkedOnQueueEntry) {
      db.prepare('UPDATE agent_tickets SET agent_state = ? WHERE id = ?').run('queued', id);
      logEvent(db, id, ROBOT_EVENT.unstick, {
        reason: 'auto-unstuck on queue entry',
        from: existing.agentState ?? undefined,
      });
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
 * `assignee` is optional — when absent, the ticket's assignee is left alone. D-058:
 * the lane no longer forces an assignee (assignee is an independent axis), so the
 * derived `assignee` (when provided) is written as-is.
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
  // The derived assignee when provided; else undefined = leave alone (D-058: no lane force).
  const effectiveAssignee = assignee;
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

/** A ticket in the `queue` lane assigned to the robot, whose project is robot-enabled with a
 *  repo — the input for the board→GitHub queued-issue sync (PD-164). `githubIssueNumber` is null
 *  when no issue has been created/linked yet. */
export interface QueuedIssueTarget {
  id: number;
  githubIssueNumber: number | null;
  githubRepo: string;
  title: string;
  body: string | null;
}

/**
 * Tickets currently in `queue` assigned to `robot` (D-058: queue + robot = the dispatch axis),
 * in a robot-enabled project with a repo — both already-linked and not-yet-linked. PD-164 ensured
 * each had a queued GitHub issue (creating + linking one when absent). A robot-assigned queued
 * ticket is therefore the dispatch trigger.
 */
export function listQueuedIssueTargets(db: Database.Database): QueuedIssueTarget[] {
  const rows = db
    .prepare(
      `SELECT t.id AS id, t.github_issue_number AS n, t.title AS title, t.body AS body, p.github_repo AS repo
         FROM agent_tickets t
         JOIN agent_projects p ON p.id = t.project_id
        WHERE t.archived_at IS NULL
          AND t.status = 'queue'
          AND t.assignee = 'robot'
          AND p.robot_enabled = 1
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

/** An Epic's priority, or `null` when the Epic is unclassified or the id is not an Epic (D-TMP-PD383a).
 *  Members inherit this; `null` deliberately leaves a member's own priority alone rather than
 *  wiping it, which is the same rule the back-fill migration follows. */
function epicPriorityOf(db: Database.Database, epicId: number): TicketPriority | null {
  const row = db
    .prepare('SELECT priority FROM agent_tickets WHERE id = ? AND is_epic = 1')
    .get(epicId) as { priority: string } | undefined;
  if (!row) return null;
  return fromDbPriority(row.priority);
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

/** An Epic's board lane (D-054, as amended by D-TMP-PD383a).
 *
 *  **D-TMP-PD383a splits this by direction.** The Epic's *own* status is now authoritative for the pending
 *  lanes — a human queues the Epic and its members follow — so a hand-set `queue` is honoured
 *  rather than treated as impossible. Progress stays derived: an Epic reads `completed`/`closed`
 *  only when its members actually got there, because that is an observation of what the loop did
 *  and no top-down push may overwrite it. */
function deriveEpicLane(memberStatuses: TicketStatus[], ownStatus: TicketStatus): EpicDerivedLane {
  if (memberStatuses.length === 0) {
    switch (ownStatus) {
      case 'queue':
        return 'in_progress';
      case 'completed':
        return 'completed';
      case 'closed':
        return 'closed';
      default:
        return 'backlog';
    }
  }
  const allDone = memberStatuses.every((s) => s === 'completed' || s === 'closed');
  if (allDone) return memberStatuses.some((s) => s === 'completed') ? 'completed' : 'closed';
  // D-TMP-PD383a: not all done, so the Epic is pending. A member still in `queue` means work is live;
  // otherwise the Epic's own lane decides, which is what makes queueing an Epic with nothing yet
  // dispatchable (every member blocked, say) still read as active rather than snapping back.
  if (memberStatuses.some((s) => s === 'queue')) return 'in_progress';
  return ownStatus === 'queue' ? 'in_progress' : 'backlog';
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
 * This is the Refine reply path — distinct from the ask_human `/reply` (PD-250), which
 * re-queues a parked Robot run; a Refine reply stays entirely in the DB.
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

/**
 * Append a human answer to a Robot `ask_human` question as a DB-native `robot_human_reply` event
 * (C5/PD-346). The Robot loop's resume sweep detects a reply newer than the ticket's last
 * `robot_ask_human` event, re-queues the ticket, and injects the Q&A into the resume prompt (the
 * coding uid is DB-blind, so the loop hands it the answer). Returns the created event, or null if
 * the ticket is unknown.
 *
 * The answer no longer has to round-trip through a GitHub issue comment + label flip (as the
 * retired ask_human path did). The server does NOT touch
 * `agent_state` here — the loop owns that transition, same as it owns every other state write.
 */
export function appendRobotReply(
  db: Database.Database,
  ticketId: number,
  text: string,
): TicketEvent | null {
  if (getTicket(db, ticketId) === null) return null;
  const now = Date.now();
  const res = db
    .prepare('INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)')
    .run(ticketId, ROBOT_EVENT.humanReply, JSON.stringify({ text }), now);
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
 * `origin` defaults to `'agent'` so the refine/audit callers need no change; the relations
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
  | {
      ok: true;
      mode: RefineCommitMode;
      refinedTicketId?: number;
      childIds?: number[];
      /** True when the approval also moved the ticket into `queue` (`queue: true`). */
      queued?: boolean;
      /** True when a decompose on an Epic was reinterpreted as `Populate` (D-058): members
       *  created via `epic_id`, the Epic left open, no `split` relations. */
      populated?: boolean;
    }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'no_proposal'
        | 'invalid_proposal'
        | 'epic_not_queueable';
      detail?: string;
    };

/**
 * Execute the latest actionable commit proposal on Steve's approval (D-044, PD-269). The
 * agent-worker only proposes; this is the single place tickets are written, so the lane→assignee
 * invariant is enforced here.
 *
 * D-057/D-058: **approval never dispatches on its own.** A plain approve rewrites/creates tickets
 * and marks them refined but never enters `queue` — an agent-proposed `queue` is parked in
 * `prioritized`. Entering the Queue is a separate, explicit act: a board drag, or the
 * "Approve & queue" button (`opts.queue`), which is offered only for a non-Epic refine_in_place.
 * `ready` is recomputed from the body on write (surfaced in the UI), not a gate here.
 *
 * Refine-in-place rewrites the ticket; decompose creates children in non-queue lanes, closes the
 * parent (D-036), and links each via a `split` relation. A decompose whose target is an Epic is
 * reinterpreted as **Populate** (D-058): members are linked by `epic_id`, the Epic stays open, and
 * no `split` relations are written. All-or-nothing (one transaction).
 */
export function approveRefine(
  db: Database.Database,
  ticketId: number,
  opts: { queue?: boolean } = {},
): ApproveRefineResult {
  const parent = getTicket(db, ticketId);
  if (!parent) return { ok: false, reason: 'not_found' };

  const found = latestActionableProposal(listTicketEvents(db, ticketId));
  if (!found) return { ok: false, reason: 'no_proposal' };
  const p = found.proposal;

  if (p.mode === 'refine_in_place') {
    const body = p.body ?? parent.body;
    const wantQueue = opts.queue === true;

    if (wantQueue) {
      // Explicit dispatch intent ("Approve & queue"). An Epic can never enter `queue`
      // (D-054/D-058) — refuse cleanly so approveRefine keeps its no-throw contract rather than
      // letting updateTicket's EpicGuardError escape the transaction. (A blocked ticket MAY be
      // queued now — the loop's selection query is the sole dispatch guard, D-051 amended by PD-408.)
      if (parent.isEpic) {
        return { ok: false, reason: 'epic_not_queueable', detail: parent.displayId ?? String(ticketId) };
      }
    }

    // PD-510, the stronger form of D-057: **an approval never moves a Ticket between lanes.** The
    // proposal's `status` is not read at all — not honoured, not parked, not coerced. Earlier this
    // parked an agent-proposed `queue` in `prioritized`, then in `backlog` once D-TMP-PD383a retired
    // that lane; both were still a lane write derived from what the agent asked for, and a proposal
    // that says "backlog" on a Ticket already in Queue would have quietly pulled it back out.
    // The one exception is Steve's own explicit "Approve & queue" (`opts.queue`) — that is a human
    // dispatching, identical in kind to a board drag, which is exactly what D-057 reserves to him.
    //
    // `priority` is gone for the same reason from the other direction: it is an Epic property that
    // the write path cascades to members, so honouring a Ticket-level one here would either be
    // overridden a moment later or, on an Epic-less Ticket, stick and disagree with the model.
    const status = wantQueue ? 'queue' : parent.status;
    const queued = wantQueue;

    const run = db.transaction(() => {
      updateTicket(db, ticketId, {
        body,
        status,
        assignee: p.assignee === undefined ? parent.assignee : p.assignee,
        // PD-432: an estimated ceiling from the proposal, else leave the ticket's own as it is.
        maxTurns: p.maxTurns === undefined ? parent.maxTurns : p.maxTurns,
        refined: true,
      });
      logProposalEvent(db, ticketId, REFINE_PROPOSAL_EVENT.committed, { mode: p.mode, queued });
    });
    run();
    return { ok: true, mode: p.mode, refinedTicketId: ticketId, queued };
  }

  // decompose / populate (D-058)
  // A non-Epic decompose closes the parent (D-036) and links children via `split`. When the target
  // is an Epic we reinterpret the same proposal as **Populate**: members are linked by `epic_id`,
  // the Epic is LEFT OPEN (its lane derives from its members, D-054), and no `split` relations are
  // written — an Epic umbrella must stay open to hold its members. This reinterpret (rather than the
  // old `cannot decompose an Epic` refusal) is what lets PD-382's existing split-shaped proposal
  // approve cleanly with no re-run.
  const populate = parent.isEpic;
  const children = p.children ?? [];
  if (children.length === 0) return { ok: false, reason: 'invalid_proposal', detail: 'no children' };
  if (parent.projectId === null) {
    return { ok: false, reason: 'invalid_proposal', detail: 'parent has no project' };
  }
  const projectId = parent.projectId;
  const childIds: number[] = [];
  const run = db.transaction(() => {
    for (const c of children) {
      // PD-510: **a Refine-created child is always born in `backlog`.** The child's proposed
      // `status` is not read — which makes D-039 ("an autonomous agent may create into backlog
      // only") structural here rather than a lane-coercion chain that had to grow a new case each
      // time a lane was retired (`robot_queue`/`steve_queue` in PD-417, `prioritized` in
      // D-TMP-PD383a). It also closes the quieter half: a child proposed as `completed`/`closed`
      // used to be created already terminal, i.e. work asserted as finished before it existed.
      // The shaped body is preserved either way, so a child stays one drag from dispatch.
      //
      // Populate into a queued Epic lands in `backlog` too — `createTicket` enforces that
      // independently (D-TMP-PD383a), so joining an in-flight Epic stays an explicit act.
      const child = createTicket(db, {
        title: c.title,
        body: c.body,
        status: 'backlog',
        assignee: c.assignee ?? undefined,
        // Priority comes from the Epic, never the proposal; `createTicket` cascades it on insert.
        priority: null,
        // PD-432: the child's estimated ceiling, when the agent argued the work is irreducible.
        maxTurns: c.maxTurns ?? null,
        projectId,
        // Populate: members belong to the Epic itself. Split: children inherit the parent's Epic
        // (if any), staying under the same umbrella (D-054 split-inheritance).
        epicId: populate ? parent.id : parent.epicId,
      });
      // `split` lineage is a decompose-only relation; Populate links purely by membership.
      if (!populate) addRelation(db, ticketId, child.id, 'split');
      childIds.push(child.id);
    }
    // Only a decompose closes the parent (D-036); Populate leaves the Epic open.
    if (!populate) updateTicket(db, ticketId, { status: 'closed' });
    logProposalEvent(db, ticketId, REFINE_PROPOSAL_EVENT.committed, {
      mode: p.mode,
      childIds,
      ...(populate ? { populated: true } : {}),
    });
  });
  run();
  return { ok: true, mode: p.mode, childIds, queued: false, ...(populate ? { populated: true } : {}) };
}

export type RejectRefineResult = { ok: true } | { ok: false; reason: 'not_found' | 'no_proposal' };

/** Drop the latest actionable proposal (Steve rejected); the refine session can propose again. */
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
  /** The grounding checkout's HEAD — what the agent reads. */
  sha: string | null;
  /** The commit the running image was built from (PD-528); null on a pre-build-arg image. */
  build_sha: string | null;
  model: string | null;
}

/** Count active (non-archived) tickets by Robot loop `agent_state`. Only states that
 *  actually occur appear in the map — a state with zero tickets is simply absent.
 *  Pure aggregation over existing rows; no new data source. (Kept as `getSortieFleet`
 *  to match the stable `sortie` Site Status wire field.) */
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

/**
 * The tickets parked waiting on a human — stuck, needs-human, awaiting-human (PD-498).
 *
 * Identities, not a count, because the nav's "N needs you" is only useful if it goes somewhere. A
 * count alone forces the reader to the board and then to hunt for which ticket it meant, which is
 * the trip the number was supposed to save them.
 *
 * Capped: this rides on a 30s poll and the nav can only act on one link. Past a handful the right
 * destination is the board anyway, so there is nothing to gain from carrying fifty rows.
 */
export function getNeedsHumanTickets(db: Database.Database, limit = 10): NeedsHumanTicket[] {
  return db
    .prepare(
      `SELECT id, display_id AS displayId, title, agent_state AS agentState
         FROM agent_tickets
        WHERE archived_at IS NULL
          AND agent_state IN ('stuck', 'needs-human', 'awaiting-human')
        ORDER BY updated_at DESC
        LIMIT ?`,
    )
    .all(limit) as NeedsHumanTicket[];
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

/** The loop-wide budget ceiling and the spend against it (PD-463). The ceiling is worker config —
 *  the web process cannot read the worker's env — so the worker publishes its EFFECTIVE policy into
 *  `robot_state.budget_policy` and this sums the window from `agent_runs`. Null until a worker has
 *  published one (never booted, or an older build), which the UI reads as "nothing to show" rather
 *  than inventing a ceiling that isn't being enforced.
 *
 *  Mirrors the worker's window arithmetic exactly, including counting an in-flight run by its
 *  `started_at`: a long-running Robot's turns are spent whether or not the run has landed. */
export function getRobotBudget(db: Database.Database, now: number = Date.now()): RobotBudgetStatus | null {
  const policy = (() => {
    try {
      const row = db.prepare("SELECT value FROM robot_state WHERE key = 'budget_policy'").get() as
        | { value: string | null }
        | undefined;
      if (!row || row.value === null) return null;
      const p = JSON.parse(row.value) as { windowMs?: unknown; turns?: unknown; tokens?: unknown };
      if (typeof p.windowMs !== 'number' || p.windowMs <= 0) return null;
      return {
        windowMs: p.windowMs,
        turns: typeof p.turns === 'number' ? p.turns : 0,
        tokens: typeof p.tokens === 'number' ? p.tokens : 0,
      };
    } catch {
      return null; // no robot_state table, or a corrupt row — neither should break the status API
    }
  })();
  if (!policy) return null;

  const used = (() => {
    try {
      return db
        .prepare(
          `SELECT COALESCE(SUM(turns), 0) AS turns, COALESCE(SUM(tokens), 0) AS tokens
             FROM agent_runs
            WHERE COALESCE(finished_at, started_at) >= ?`,
        )
        .get(now - policy.windowMs) as { turns: number; tokens: number };
    } catch {
      return { turns: 0, tokens: 0 }; // agent_runs is worker-owned; absent ⇒ nothing spent
    }
  })();

  return {
    windowMs: policy.windowMs,
    turnsUsed: used.turns,
    turnsLimit: policy.turns > 0 ? policy.turns : null,
    tokensUsed: used.tokens,
    tokensLimit: policy.tokens > 0 ? policy.tokens : null,
  };
}

/** The Robot loop's session-limit hold (PD-470), read from the same worker-owned `robot_state`
 *  table. Distinct from the pause above: this one has an end time and clears itself when the loop
 *  next runs, so the UI shows "waiting until X", not "someone must fix this". Read-only, and
 *  tolerant of an absent table, a null row, or corrupt JSON — none of those should break the
 *  status endpoint. An EXPIRED hold reads as none: the row lingers until the worker's next cycle
 *  clears it, and showing a wait that has already ended would be a lie. */
/**
 * The worker's last GitHub rate-limit probe (PD-248), read from `robot_state`.
 *
 * Returned as stored, INCLUDING an old `checkedAt` — staleness is the reader's call
 * (`rateLimitHealth`), not this function's. Silently dropping an old reading here would make a
 * failing probe indistinguishable from one that has never run, and those need different responses.
 * Tolerant of an absent table, a null row, or corrupt JSON: none of those should break the status
 * endpoint.
 */
export function getGithubRateLimit(db: Database.Database): GithubRateLimitStatus | null {
  const row = (() => {
    try {
      return db.prepare("SELECT value FROM robot_state WHERE key = 'github_rate_limit'").get() as
        | { value: string | null }
        | undefined;
    } catch {
      return undefined;
    }
  })();
  if (!row || row.value === null) return null;
  try {
    const parsed = JSON.parse(row.value) as GithubRateLimitStatus;
    if (typeof parsed?.core?.remaining !== 'number' || typeof parsed?.checkedAt !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function getSessionLimitHold(db: Database.Database, now: number = Date.now()): SessionLimitHoldState | null {
  const row = (() => {
    try {
      return db.prepare("SELECT value, updated_at FROM robot_state WHERE key = 'session_limit_until'").get() as
        | { value: string | null; updated_at: number }
        | undefined;
    } catch {
      return undefined;
    }
  })();
  if (!row || row.value === null) return null;
  try {
    const parsed = JSON.parse(row.value) as { until?: unknown; reason?: unknown; kind?: unknown };
    if (typeof parsed.until !== 'number' || parsed.until <= now) return null;
    return {
      // PD-248: rows written before the GitHub-rate-limit hold existed carry no kind, and every one
      // of them was a session limit — so an absent kind reads as exactly what it was.
      kind: parsed.kind === 'github-rate-limit' ? 'github-rate-limit' : 'session-limit',
      until: parsed.until,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      since: row.updated_at,
    };
  } catch {
    return null;
  }
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
    checkoutSha: r.sha,
    buildSha: r.build_sha ?? null,
    model: r.model,
  }));
}
