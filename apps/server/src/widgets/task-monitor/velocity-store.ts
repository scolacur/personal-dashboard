import type Database from 'better-sqlite3';
import {
  buildEpicBurndowns,
  buildRunReport,
  buildVelocityReport,
  reconstructLifecycles,
  type EpicBurndown,
  type ReportWindow,
  type RunReport,
  type TicketLifecycle,
  type VelocityEventInput,
  type VelocityReport,
  type VelocityRunInput,
  type VelocityTicketInput,
} from '@dashboard/shared';

/**
 * Cross-ticket aggregates for the Dev Ops Velocity page (Epic PD-895). Every other reader of
 * `agent_ticket_events` is per-ticket; these scan the whole log, then hand the rows to the pure
 * reconstruction in `@dashboard/shared` (velocity.ts), which owns all the counting rules.
 * Archived (soft-deleted) tickets are excluded — they were never real work.
 */

export interface VelocityFilter extends ReportWindow {
  projectId?: number | null;
}

/** Event types that carry lifecycle meaning; everything else in the log is ignored. */
const LIFECYCLE_EVENT_TYPES = ['created', 'robot_completed', 'status_changed'];

/** Every live ticket in scope, replayed into its lifecycle. */
export function loadLifecycles(
  db: Database.Database,
  projectId?: number | null,
): TicketLifecycle[] {
  const scope = projectId != null ? 'AND project_id = @projectId' : '';
  const tickets = (
    db
      .prepare(
        `SELECT id, is_epic, assignee, created_at FROM agent_tickets
          WHERE archived_at IS NULL ${scope}`,
      )
      .all({ projectId }) as {
      id: number;
      is_epic: number;
      assignee: string | null;
      created_at: number;
    }[]
  ).map((r): VelocityTicketInput => ({
    id: r.id,
    isEpic: r.is_epic === 1,
    assignee: r.assignee,
    createdAt: r.created_at,
  }));
  const placeholders = LIFECYCLE_EVENT_TYPES.map(() => '?').join(',');
  const events = (
    db
      .prepare(
        `SELECT e.ticket_id, e.type, json_extract(e.detail, '$.to') AS to_status, e.created_at
           FROM agent_ticket_events e
           JOIN agent_tickets t ON t.id = e.ticket_id
          WHERE e.type IN (${placeholders}) AND t.archived_at IS NULL
            ${projectId != null ? 'AND t.project_id = ?' : ''}`,
      )
      .all(...LIFECYCLE_EVENT_TYPES, ...(projectId != null ? [projectId] : [])) as {
      ticket_id: number;
      type: string;
      to_status: unknown;
      created_at: number;
    }[]
  ).map((r): VelocityEventInput => ({
    ticketId: r.ticket_id,
    type: r.type,
    to: typeof r.to_status === 'string' ? r.to_status : null,
    at: r.created_at,
  }));
  return reconstructLifecycles(tickets, events);
}

/** Weekly completions, burndown and cycle time (PD-859). */
export function getVelocityReport(
  db: Database.Database,
  filter: VelocityFilter = {},
  now = Date.now(),
): VelocityReport {
  return buildVelocityReport(loadLifecycles(db, filter.projectId), now, filter);
}

/**
 * Weekly Robot-loop health from `agent_runs` (PD-860). The worker owns that table and creates it
 * on boot, so it is absent on a volume where the worker never ran — return the empty report then,
 * as every other `agent_runs` reader does, never a 500.
 */
export function getRunReport(
  db: Database.Database,
  filter: VelocityFilter = {},
  now = Date.now(),
): RunReport {
  let rows: {
    ticket_id: number;
    status: string;
    fault_tier: string | null;
    turns: number | null;
    max_turns: number | null;
    started_at: number;
    finished_at: number | null;
  }[];
  try {
    rows = db
      .prepare(
        `SELECT r.ticket_id, r.status, r.fault_tier, r.turns, r.max_turns, r.started_at, r.finished_at
           FROM agent_runs r
           ${filter.projectId != null ? 'JOIN agent_tickets t ON t.id = r.ticket_id WHERE t.project_id = ?' : ''}`,
      )
      .all(...(filter.projectId != null ? [filter.projectId] : [])) as typeof rows;
  } catch {
    rows = [];
  }
  const runs = rows.map((r): VelocityRunInput => ({
    ticketId: r.ticket_id,
    status: r.status,
    faultTier: r.fault_tier,
    turns: r.turns,
    maxTurns: r.max_turns,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  }));
  return buildRunReport(runs, now, filter);
}

/**
 * Per-Epic burndown (PD-897): each Epic's CURRENT members replayed week by week as open / done /
 * dropped. Membership changes are not logged (no event when `epic_id` moves), so this cannot know
 * who belonged when — the page labels it. Epics with no live members are omitted.
 */
export function getEpicBurndowns(
  db: Database.Database,
  filter: Pick<VelocityFilter, 'projectId'> = {},
  now = Date.now(),
): EpicBurndown[] {
  const scope = filter.projectId != null ? 'AND e.project_id = @projectId' : '';
  const epics = db
    .prepare(
      `SELECT e.id, e.display_id, e.title, e.status
         FROM agent_tickets e
        WHERE e.is_epic = 1 AND e.archived_at IS NULL ${scope}`,
    )
    .all({ projectId: filter.projectId }) as {
    id: number;
    display_id: string | null;
    title: string;
    status: string;
  }[];
  const members = db
    .prepare(
      `SELECT id, epic_id FROM agent_tickets
        WHERE epic_id IS NOT NULL AND is_epic = 0 AND archived_at IS NULL`,
    )
    .all() as { id: number; epic_id: number }[];
  const byEpic = new Map<number, number[]>();
  for (const m of members) {
    const list = byEpic.get(m.epic_id);
    if (list) list.push(m.id);
    else byEpic.set(m.epic_id, [m.id]);
  }
  return buildEpicBurndowns(
    epics.map((e) => ({
      id: e.id,
      displayId: e.display_id,
      title: e.title,
      status: e.status,
      memberIds: byEpic.get(e.id) ?? [],
    })),
    loadLifecycles(db, filter.projectId),
    now,
  );
}
