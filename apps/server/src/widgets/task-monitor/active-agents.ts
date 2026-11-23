import type Database from 'better-sqlite3';
import type { ActiveAgent } from '@dashboard/shared';

/**
 * PD-819: the agent runs in flight right now, one row per robot tile on the Agent Dashboard.
 *
 * Read-only over three run tables. Two of them (`agent_runs`, `evaluator_runs`) are created by the
 * agent-worker, not the server, so each read is guarded: a DB the worker has never booted against
 * has no such table, and that must read as "nobody working", not a 500 on the status endpoint.
 *
 * A run left `running` by a dead worker would otherwise pose as a live robot forever. The stall
 * reconciler (D-104) closes those for Robot runs, but not instantly and not for the other kinds,
 * so anything older than STALE_RUN_MS is dropped here as a display-side backstop.
 */
export const STALE_RUN_MS = 6 * 60 * 60 * 1000;

interface TicketJoin {
  ticket_id: number | null;
  display_id: string | null;
  title: string | null;
  project_id: number | null;
  project_name: string | null;
  project_color: string | null;
}

const TICKET_JOIN = `
  LEFT JOIN agent_tickets t ON t.id = r.ticket_id
  LEFT JOIN agent_projects p ON p.id = t.project_id`;
const TICKET_COLS = `r.ticket_id, t.display_id, t.title, t.project_id,
  p.name AS project_name, p.color AS project_color`;

function ticketOf(r: TicketJoin): Pick<ActiveAgent, 'ticket' | 'project'> {
  return {
    ticket:
      r.ticket_id !== null && r.title !== null
        ? { id: r.ticket_id, displayId: r.display_id, title: r.title }
        : null,
    project:
      r.project_id !== null && r.project_name !== null
        ? { id: r.project_id, name: r.project_name, color: r.project_color }
        : null,
  };
}

/** Run a read against a table that may not exist yet; a missing table reads as no rows. */
function safeAll<T>(db: Database.Database, sql: string, ...params: unknown[]): T[] {
  try {
    return db.prepare(sql).all(...params) as T[];
  } catch {
    return [];
  }
}

/** The model the Robot runs under. `agent_runs` has no model column — the coding model is the
 *  worker's `AGENT_WORKER_MODEL`, which it reports on its heartbeat. */
function robotModel(db: Database.Database): string | null {
  const row = safeAll<{ model: string | null }>(
    db,
    'SELECT model FROM worker_heartbeat WHERE model IS NOT NULL ORDER BY last_seen DESC LIMIT 1',
  )[0];
  return row?.model ?? null;
}

export function getActiveAgents(db: Database.Database, now: number = Date.now()): ActiveAgent[] {
  const since = now - STALE_RUN_MS;
  const agents: ActiveAgent[] = [];

  const model = robotModel(db);
  for (const r of safeAll<
    TicketJoin & { id: number; started_at: number; turns: number | null; max_turns: number | null; tokens: number | null }
  >(
    db,
    `SELECT r.id, r.started_at, r.turns, r.max_turns, r.tokens, ${TICKET_COLS}
       FROM agent_runs r ${TICKET_JOIN}
      WHERE r.status = 'running' AND r.started_at >= ?
      ORDER BY r.started_at`,
    since,
  )) {
    agents.push({
      kind: 'robot',
      runId: r.id,
      startedAt: r.started_at,
      ...ticketOf(r),
      turns: r.turns,
      maxTurns: r.max_turns,
      tokens: r.tokens,
      model,
      detail: null,
    });
  }

  for (const r of safeAll<
    TicketJoin & {
      id: number;
      started_at: number;
      round: number;
      pr_number: number;
      turns: number | null;
      tokens: number | null;
      model: string | null;
    }
  >(
    db,
    `SELECT r.id, r.started_at, r.round, r.pr_number, r.turns, r.tokens, r.model, ${TICKET_COLS}
       FROM evaluator_runs r ${TICKET_JOIN}
      WHERE r.finished_at IS NULL AND r.started_at >= ?
      ORDER BY r.started_at`,
    since,
  )) {
    agents.push({
      kind: 'evaluator',
      runId: r.id,
      startedAt: r.started_at,
      ...ticketOf(r),
      turns: r.turns,
      maxTurns: null,
      tokens: r.tokens,
      model: r.model,
      detail: `round ${r.round} · PR #${r.pr_number}`,
    });
  }

  for (const r of safeAll<{
    id: number;
    started_at: number;
    scope: string | null;
    model: string | null;
    turns: number | null;
    tokens: number | null;
  }>(
    db,
    // PD-910: turns/tokens are written live by the worker (columns from the
    // audit_run_add_turns_tokens migration).
    `SELECT id, started_at, scope, model, turns, tokens FROM audit_run
      WHERE status = 'running' AND started_at IS NOT NULL AND started_at >= ?
      ORDER BY started_at`,
    since,
  )) {
    agents.push({
      kind: 'auditor',
      runId: r.id,
      startedAt: r.started_at,
      ticket: null,
      project: null,
      turns: r.turns,
      maxTurns: null,
      tokens: r.tokens,
      model: r.model,
      detail: r.scope ? `scope ${r.scope}` : 'all projects',
    });
  }

  return agents;
}
