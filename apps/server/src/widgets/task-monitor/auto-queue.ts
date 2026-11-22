import type Database from 'better-sqlite3';
import type {
  AgentTicket,
  AutoQueueBoardEligibility,
  AutoQueueEligibility,
  AutoQueueCapacity,
  AutoQueueCapacityRow,
  AutoQueueEligibilityResponse,
} from '@dashboard/shared';
import {
  AGENT_WORKER_HEARTBEAT_STALE_MS,
  AUTO_QUEUE_CAPACITY_DEFS,
  AUTO_QUEUE_EPIC_IN_FLIGHT_LIMIT,
  AUTO_QUEUE_QUEUE_DEPTH_FACTOR,
  AUTO_QUEUE_REVIEW_WIP_LIMIT,
  ROBOT_CAPACITY_POLICY_KEY,
  ROBOT_CONCURRENCY_DEFAULT,
  autoQueueEligibility,
  autoQueueEpicEligibility,
  parseAutoQueueMode,
} from '@dashboard/shared';
import {
  getDispatchPauseState,
  getProjectById,
  getRobotBudget,
  getSessionLimitHold,
  getTicket,
  listEpicMembers,
  listTickets,
  listWorkerHeartbeats,
  unresolvedBlockers,
} from './store';
import { getMaintenanceHoldStatus } from '../../lib/maintenance-holds';

// Auto-queue eligibility + capacity (D-103, PD-808).
//
// This is the DB-bound half of the auto-queue answer. The pure predicate + verdict taxonomy live in
// `packages/shared` (`autoQueueEligibility` / `autoQueueEpicEligibility`); here we only gather the
// rows those functions read — the ticket, its Epic + members, open blockers, the project — and the
// board/worker-wide capacity snapshot. Nothing here promotes anything (D-103: the promoter itself is
// a later ticket); it is a read.

/** The ticket's Epic as the eligibility predicate reads it, or null when it has none. */
function eligEpic(db: Database.Database, epicId: number | null): (ReturnType<typeof toEligEpic>) | null {
  if (epicId === null) return null;
  const epic = getTicket(db, epicId);
  return epic ? toEligEpic(epic) : null;
}

function toEligEpic(epic: AgentTicket) {
  return {
    id: epic.id,
    refined: epic.refined,
    refineStale: epic.refineStale,
    status: epic.status,
    autoQueueExcluded: epic.autoQueueExcluded ?? false,
  };
}

function eligProject(db: Database.Database, projectId: number | null) {
  if (projectId === null) return null;
  const p = getProjectById(db, projectId);
  return p ? { robotEnabled: p.robotEnabled, githubRepo: p.githubRepo } : null;
}

/** Ids of a ticket's unresolved `blocks` blockers. */
function openBlockerIds(db: Database.Database, ticketId: number): number[] {
  return unresolvedBlockers(db, ticketId).map((b) => b.ticketId);
}

/* ── Capacity (board / worker-wide, D-103 §4) ──────────────────────────────── */

/** Dispatchable robot tickets sitting in the Queue right now — the server-side mirror of the loop's
 *  `robotQueueCandidates` selection (queue + robot + Ready/bypassed + refined + fresh agent_state +
 *  robot-enabled repo + unblocked). Counted, not listed. */
export function countDispatchableRobotTickets(db: Database.Database): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM agent_tickets t
         JOIN agent_projects p ON p.id = t.project_id
        WHERE t.archived_at IS NULL
          AND t.status = 'queue'
          AND t.assignee = 'robot'
          AND (t.ready = 1 OR t.ready_bypassed = 1)
          AND t.refined = 1
          AND (t.agent_state IS NULL OR t.agent_state = 'queued')
          AND p.robot_enabled = 1
          AND p.github_repo IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
              FROM agent_ticket_relations r
              JOIN agent_tickets blocker ON blocker.id = r.from_ticket_id
             WHERE r.type = 'blocks'
               AND r.to_ticket_id = t.id
               AND blocker.archived_at IS NULL
               AND blocker.status NOT IN ('completed', 'closed')
          )`,
    )
    .get() as { n: number };
  return row.n;
}

/** Robot tickets awaiting review (incl. PRs held by the review/visual gate or conflicting — all of
 *  which keep `agent_state = 'in-review'`). */
export function countRobotInReview(db: Database.Database): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM agent_tickets
        WHERE archived_at IS NULL AND assignee = 'robot' AND agent_state = 'in-review'`,
    )
    .get() as { n: number };
  return row.n;
}

/** Members of one Epic that are in flight: queued-not-dispatched, working, or in review. */
export function countEpicInFlight(db: Database.Database, epicId: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM agent_tickets
        WHERE archived_at IS NULL AND epic_id = ? AND status = 'queue'
          AND (agent_state IS NULL OR agent_state IN ('queued', 'working', 'in-review'))`,
    )
    .get(epicId) as { n: number };
  return row.n;
}

/** The loop's effective concurrency, published by the worker into `robot_state` (mirrors the budget
 *  policy — the web process cannot read `ROBOT_CONCURRENCY`). Falls back to the env default. */
export function robotConcurrency(db: Database.Database): number {
  try {
    const row = db.prepare('SELECT value FROM robot_state WHERE key = ?').get(ROBOT_CAPACITY_POLICY_KEY) as
      | { value: string | null }
      | undefined;
    if (!row?.value) return ROBOT_CONCURRENCY_DEFAULT;
    const parsed = JSON.parse(row.value) as { concurrency?: unknown };
    return typeof parsed.concurrency === 'number' && parsed.concurrency > 0
      ? parsed.concurrency
      : ROBOT_CONCURRENCY_DEFAULT;
  } catch {
    return ROBOT_CONCURRENCY_DEFAULT; // no robot_state table / corrupt row ⇒ the default, not a throw
  }
}

/** Why the worker is not healthy right now, or null when it is — the composite behind the
 *  `worker-healthy` capacity limb (D-103 §4). */
export function workerUnhealthyReason(db: Database.Database, now: number = Date.now()): string | null {
  if (getDispatchPauseState(db).paused) return 'Dispatch is paused.';
  const hold = getSessionLimitHold(db, now);
  if (hold) {
    return hold.kind === 'github-rate-limit'
      ? 'A GitHub rate-limit hold is active.'
      : 'A session-limit hold is active.';
  }
  if (getMaintenanceHoldStatus(db)) return 'A maintenance hold is active.';
  const budget = getRobotBudget(db, now);
  if (
    budget &&
    ((budget.turnsLimit !== null && budget.turnsUsed >= budget.turnsLimit) ||
      (budget.tokensLimit !== null && budget.tokensUsed >= budget.tokensLimit))
  ) {
    return 'The loop-wide budget is exhausted.';
  }
  // GitHub rate limits surface as the hold above; low headroom alone does not gate promotion.
  const workers = listWorkerHeartbeats(db);
  const worker = workers.find((w) => w.worker === 'agent-worker') ?? workers[0];
  if (!worker || now - worker.lastSeen > AGENT_WORKER_HEARTBEAT_STALE_MS) {
    return 'The worker heartbeat is stale — its health cannot be confirmed.';
  }
  return null;
}

const CAPACITY_DEF_BY_ID = new Map(AUTO_QUEUE_CAPACITY_DEFS.map((d) => [d.id, d] as const));

/** One capacity limb. `label`/`description` come from `AUTO_QUEUE_CAPACITY_DEFS` (the single source
 *  the board's criteria modal also renders, PD-810) so the live rows and the modal cannot drift. */
function capacityRow(
  id: AutoQueueCapacityRow['id'],
  current: number,
  limit: number,
  reason: string,
): AutoQueueCapacityRow {
  const def = CAPACITY_DEF_BY_ID.get(id)!;
  const met = current < limit;
  return { id, label: def.label, description: def.description, current, limit, met, ...(met ? {} : { reason }) };
}

/** A non-negative integer env var, falling back to `def` for anything missing or malformed. */
function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : def;
}

/**
 * The promoter's capacity limits, env-configurable with the D-103 §4 defaults (PD-811). Read on
 * every capacity computation so the board, the checklist and the promoter all enforce the same
 * numbers — the shared `AUTO_QUEUE_*` constants are the defaults, the env vars the overrides.
 */
export function autoQueueLimits(): { queueDepthFactor: number; reviewWip: number; epicInFlight: number } {
  return {
    queueDepthFactor: envInt('AUTO_QUEUE_QUEUE_DEPTH_FACTOR', AUTO_QUEUE_QUEUE_DEPTH_FACTOR),
    reviewWip: envInt('AUTO_QUEUE_REVIEW_WIP_LIMIT', AUTO_QUEUE_REVIEW_WIP_LIMIT),
    epicInFlight: envInt('AUTO_QUEUE_EPIC_IN_FLIGHT_LIMIT', AUTO_QUEUE_EPIC_IN_FLIGHT_LIMIT),
  };
}

/** The four limbs' current/limit values, so both `computeAutoQueueCapacity` (DB-read) and the
 *  promoter (in-memory simulation across a tick) build the SAME row shape from one place. */
export interface CapacityInputs {
  queueDepthCurrent: number;
  queueDepthLimit: number;
  reviewWipCurrent: number;
  reviewWipLimit: number;
  epicInFlightCurrent: number;
  epicInFlightLimit: number;
  /** The `worker-healthy` composite reason, or null when the worker is healthy. */
  unhealthyReason: string | null;
}

/** Assemble the capacity snapshot from already-gathered currents/limits (D-103 §4). */
export function buildAutoQueueCapacity(inputs: CapacityInputs): AutoQueueCapacity {
  const rows: AutoQueueCapacityRow[] = [
    capacityRow(
      'queue-depth',
      inputs.queueDepthCurrent,
      inputs.queueDepthLimit,
      'The Queue already holds enough dispatchable robot work.',
    ),
    capacityRow(
      'review-wip',
      inputs.reviewWipCurrent,
      inputs.reviewWipLimit,
      'Too many robot PRs are already awaiting review.',
    ),
    capacityRow(
      'epic-in-flight',
      inputs.epicInFlightCurrent,
      inputs.epicInFlightLimit,
      'A member of this Epic is already in flight.',
    ),
    // `worker-healthy` reuses the same helper: current=1 (unhealthy) trips `current < limit` so the
    // limb fails and carries the composite reason; current=0 (healthy) passes with no reason.
    capacityRow('worker-healthy', inputs.unhealthyReason ? 1 : 0, 1, inputs.unhealthyReason ?? ''),
  ];
  return { rows, ok: rows.every((r) => r.met) };
}

/**
 * The board/worker-wide capacity snapshot the promoter evaluates each tick (D-103 §4). `epicId`
 * scopes the per-Epic `epic-in-flight` limb; pass null for a snapshot with no Epic in view.
 */
export function computeAutoQueueCapacity(
  db: Database.Database,
  epicId: number | null,
  now: number = Date.now(),
): AutoQueueCapacity {
  const limits = autoQueueLimits();
  return buildAutoQueueCapacity({
    queueDepthCurrent: countDispatchableRobotTickets(db),
    queueDepthLimit: robotConcurrency(db) * limits.queueDepthFactor,
    reviewWipCurrent: countRobotInReview(db),
    reviewWipLimit: limits.reviewWip,
    epicInFlightCurrent: epicId === null ? 0 : countEpicInFlight(db, epicId),
    epicInFlightLimit: limits.epicInFlight,
    unhealthyReason: workerUnhealthyReason(db, now),
  });
}

/** A Backlog ticket the promoter may consider, in dispatch order. */
export interface PromotionCandidate {
  id: number;
  displayId: string;
  epicId: number | null;
}

// Mirrors `PRIORITY_UNSET` in the store / agent-worker select.ts: the column is TEXT NOT NULL
// DEFAULT 'none', so "unset" is this sentinel and never SQL NULL.
const PRIORITY_UNSET = 'none';

/**
 * Live, non-Epic Backlog tickets in the SAME dispatch order the loop's `robotQueueCandidates` uses
 * (Epic priority, Epic `sort_order`, member `sort_order`, id — D-080/PD-294), so the promoter pulls
 * work in exactly the order it would next be dispatched (D-103 §4). Eligibility + capacity are judged
 * per candidate by the promoter; this is purely the ordered candidate set.
 */
export function backlogPromotionCandidates(db: Database.Database): PromotionCandidate[] {
  const rows = db
    .prepare(
      `SELECT t.id AS id, t.display_id AS display_id, t.epic_id AS epic_id
         FROM agent_tickets t
         LEFT JOIN agent_tickets e ON e.id = t.epic_id
        WHERE t.archived_at IS NULL
          AND t.status = 'backlog'
          AND t.is_epic = 0
        ORDER BY CASE WHEN t.priority IS NULL OR t.priority = ? THEN 1 ELSE 0 END,
                 t.priority ASC,
                 COALESCE(e.sort_order, 0) ASC,
                 t.sort_order ASC,
                 t.id ASC`,
    )
    .all(PRIORITY_UNSET) as { id: number; display_id: string; epic_id: number | null }[];
  return rows.map((r) => ({ id: r.id, displayId: r.display_id, epicId: r.epic_id }));
}

/* ── Per-ticket / per-Epic eligibility ─────────────────────────────────────── */

/**
 * The full auto-queue answer for one ticket (D-103): its eligibility (or, for an Epic, the Epic-level
 * criteria + a per-member verdict roll-up) plus the capacity snapshot. Returns null for an unknown
 * ticket. Pure-function logic lives in `packages/shared`; this only gathers the rows.
 */
export function getTicketAutoQueueEligibility(
  db: Database.Database,
  id: number,
  now: number = Date.now(),
): AutoQueueEligibilityResponse | null {
  const ticket = getTicket(db, id);
  if (!ticket) return null;

  if (ticket.isEpic) {
    const members = listEpicMembers(db, id);
    const openBlockerIdsByMember: Record<number, number[]> = {};
    for (const m of members) openBlockerIdsByMember[m.id] = openBlockerIds(db, m.id);
    const epicEligibility = autoQueueEpicEligibility({
      epic: toEligEpic(ticket),
      members,
      project: eligProject(db, ticket.projectId),
      openBlockerIdsByMember,
    });
    return {
      ticketId: id,
      isEpic: true,
      epicEligibility,
      capacity: computeAutoQueueCapacity(db, id, now),
      mode: parseAutoQueueMode(process.env.AUTO_QUEUE),
    };
  }

  const epic = eligEpic(db, ticket.epicId);
  const eligibility = autoQueueEligibility({
    ticket,
    epic,
    members: epic ? listEpicMembers(db, epic.id) : [],
    openBlockerIds: openBlockerIds(db, id),
    project: eligProject(db, ticket.projectId),
  });
  return {
    ticketId: id,
    isEpic: false,
    eligibility,
    capacity: computeAutoQueueCapacity(db, ticket.epicId, now),
    mode: parseAutoQueueMode(process.env.AUTO_QUEUE),
  };
}

/**
 * Eligibility for every live Backlog ticket in one read — what the board's Eligible view (PD-810)
 * renders without a round-trip per card (D-103 §3). Epics, their members and projects are read once
 * each and reused across the tickets that share them. Carries the board-wide capacity snapshot plus
 * each Epic's in-flight count, since `epic-in-flight` is the one capacity limb that differs per card.
 */
export function listBacklogAutoQueueEligibility(
  db: Database.Database,
  now: number = Date.now(),
): AutoQueueBoardEligibility {
  const backlog = listTickets(db).filter((t) => t.status === 'backlog' && !t.isEpic && t.archivedAt === null);

  const epics = new Map<number, ReturnType<typeof eligEpic>>();
  const members = new Map<number, AgentTicket[]>();
  const projects = new Map<number, ReturnType<typeof eligProject>>();
  const epicInFlight: Record<number, number> = {};
  const tickets: Record<number, AutoQueueEligibility> = {};

  for (const t of backlog) {
    let epic: ReturnType<typeof eligEpic> = null;
    if (t.epicId !== null) {
      if (!epics.has(t.epicId)) {
        epics.set(t.epicId, eligEpic(db, t.epicId));
        members.set(t.epicId, listEpicMembers(db, t.epicId));
        epicInFlight[t.epicId] = countEpicInFlight(db, t.epicId);
      }
      epic = epics.get(t.epicId) ?? null;
    }
    const projectKey = t.projectId ?? -1;
    if (!projects.has(projectKey)) projects.set(projectKey, eligProject(db, t.projectId));
    tickets[t.id] = autoQueueEligibility({
      ticket: t,
      epic,
      members: epic ? (members.get(epic.id) ?? []) : [],
      openBlockerIds: openBlockerIds(db, t.id),
      project: projects.get(projectKey) ?? null,
    });
  }

  return { capacity: computeAutoQueueCapacity(db, null, now), epicInFlight, tickets };
}
