import type Database from 'better-sqlite3';
import {
  REFINE_AUTOSTART_STATUS_KEY,
  REFINE_BACKFILL_EXCLUDED_EVENT,
  REFINE_EVENT_TYPE,
  type RefineAutostartStatus,
} from '@dashboard/shared';
import { logger } from '../../shared/logger';
import { activeSessionLimitHold, isDispatchPaused, readStateNumber, writeState } from '../robot/state';

/**
 * Refine auto-start (PD-747, D-096 §1–2): every new unrefined ticket gets a Refine session without
 * a click, paced by how fast Steve answers rather than by how many tickets exist.
 *
 * **"New" is a boundary, not a marker.** A ticket is new when it was created after auto-start was
 * first switched on — an instant recorded once, in `robot_state`. The alternative was a
 * `refine_requested` event written at creation, but tickets are created through at least five
 * doors (POST /tickets, the widget/page/app suggestion routes, Refine decompose, the Ticket Audit,
 * seeding), and D-091 already showed what a guard on only some doors is worth. A query cannot be
 * forgotten by one of them. Older tickets are the backfill's job (PD-748), not this one's.
 *
 * **Paced by open sessions, one start per cycle.** Nothing starts while the number of open
 * sessions — waiting on Steve, or the agent working — is at the cap. Counting the working ones too
 * is what stops a burst of starts overshooting the cap before any of them has asked a question.
 *
 * **Honours the existing halts, adds none.** The session-limit hold (the provider's quota is one
 * quota) and the Robot loop's `dispatch_paused` (set by a budget breach or a system-wide fault).
 * A human resuming the loop resumes this too.
 *
 * **Off unless switched on** (`REFINE_AUTOSTART_ENABLED`), like the Robot loop and the Evaluator
 * (D-076): turning on an autonomous spender should be a deliberate deploy.
 */

export interface AutostartConfig {
  enabled: boolean;
  /** No new auto-session starts while this many sessions are open. */
  openCap: number;
  /** `owner/repo` of the worker's grounding checkout. Only tickets whose project points at this repo
   *  are auto-refined: the board holds several projects, and a Refine agent grounded in this repo
   *  cannot refine another project's ticket (the C-49 session said exactly that). Empty = none. */
  repo: string;
}

/** Tickets in a project whose GitHub repo is the worker's checkout. `x` is the table alias. */
const inRepoSql = (x: string) => `${x}.project_id IN (SELECT pr.id FROM agent_projects pr WHERE pr.github_repo = ?)`;

/** `robot_state` key: the instant auto-start was first enabled (unix ms). */
export const AUTOSTART_SINCE_KEY = 'refine_autostart_since';

const ENDED = ['refine_committed', 'refine_parked'];

/** The auto-start boundary, set to `now` the first time it is asked for. Never moves afterwards. */
export function autostartSince(db: Database.Database, now: number): number {
  const since = readStateNumber(db, AUTOSTART_SINCE_KEY);
  if (since > 0) return since;
  writeState(db, AUTOSTART_SINCE_KEY, String(now), now);
  return now;
}

/**
 * Open Refine sessions: a live, non-terminal ticket whose newest Refine-state event is a turn
 * (human or agent) rather than a commit or a park. The same rule the board's pill uses (PD-743).
 */
export function openSessionCount(db: Database.Database): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM agent_tickets t
        WHERE t.archived_at IS NULL AND t.status NOT IN ('completed', 'closed')
          AND (SELECT e.type FROM agent_ticket_events e
                WHERE e.ticket_id = t.id AND e.type IN (?, ?, ?, ?)
                ORDER BY e.created_at DESC, e.id DESC LIMIT 1) IN (?, ?)`,
    )
    .get(REFINE_EVENT_TYPE.human, REFINE_EVENT_TYPE.agent, ...ENDED, REFINE_EVENT_TYPE.human, REFINE_EVENT_TYPE.agent) as {
    n: number;
  };
  return row.n;
}

// ── One candidate list, priority-ordered (T1011) ──────────────────────────────
//
// Before T1011 there were two lists — new tickets (created at/after the boundary, ordered by age
// and *ignoring priority*) and the PD-748 backfill (older tickets, priority-ordered with the Epic
// gate) — tried in that order. Steve files new tickets constantly, so the priority-ordered backfill
// almost never got a turn: P2 new sessions crowded out P1 Epics that had never been refined. T1011
// collapses them into one eligibility set, ordered by:
//   1. priority (P0 → P5, unset last),
//   2. new before old *within the same priority* (a fresh ticket is refined while it's fresh, but
//      never jumps a priority),
//   3. oldest first.
// The "new" boundary (`since`) is now only a tie-breaker, not an eligibility split.
//
// **Epics before their members.** A member waits while its Epic is itself waiting for a session or
// has one open: the Epic's Populate frames its members, and siblings refined one by one would be
// asked the same questions again. Once the Epic is refined, or its session ended without refining
// it, the member is a candidate on its own. This gate now applies to *every* candidate, new or old.
//
// **Excludable per Epic.** The newest `refine_backfill_excluded` event on an Epic switches it — and
// its members — out (the wishlist Epics for widgets that do not exist yet).
//
// **Never restart a thread.** A ticket that has ever had a Refine turn is out — a parked or finished
// session is never auto-restarted.

/** True when a ticket's own newest backfill-exclude event says excluded. `x` is the table alias. */
const excludedSql = (x: string) => `COALESCE((SELECT json_extract(b.detail, '$.excluded') FROM agent_ticket_events b
   WHERE b.ticket_id = ${x}.id AND b.type = '${REFINE_BACKFILL_EXCLUDED_EVENT}'
   ORDER BY b.created_at DESC, b.id DESC LIMIT 1), 0) = 1`;

/** True when ticket `x` has a Refine session open now (newest state event is a turn). */
const openSessionSql = (x: string) => `(SELECT s.type FROM agent_ticket_events s
   WHERE s.ticket_id = ${x}.id AND s.type IN ('refine_human', 'refine_agent', 'refine_committed', 'refine_parked')
   ORDER BY s.created_at DESC, s.id DESC LIMIT 1) IN ('refine_human', 'refine_agent')`;

/** True when ticket `x` has never had a Refine thread. */
const noThreadSql = (x: string) => `NOT EXISTS (SELECT 1 FROM agent_ticket_events n
   WHERE n.ticket_id = ${x}.id AND n.type IN ('refine_human', 'refine_agent'))`;

// A ticket eligible for an auto-start regardless of age: in Backlog (a Queue ticket is either
// already refined robot work or Steve's own to-do), unrefined, live, never had a Refine thread, not
// excluded, and not gated behind an unrefined/open-session/excluded Epic.
const ELIGIBLE_WHERE = `
  ${inRepoSql('t')} AND
  t.archived_at IS NULL AND t.status = 'backlog' AND t.refined = 0
  AND ${noThreadSql('t')}
  AND NOT (${excludedSql('t')})
  AND NOT EXISTS (
    SELECT 1 FROM agent_tickets ep
     WHERE ep.id = t.epic_id AND (
       ${excludedSql('ep')}
       OR ${openSessionSql('ep')}
       OR (ep.archived_at IS NULL AND ep.status = 'backlog' AND ep.refined = 0 AND ${noThreadSql('ep')})
     )
  )`;

const PRIORITY_RANK = `CASE t.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3
  WHEN 'P4' THEN 4 WHEN 'P5' THEN 5 ELSE 9 END`;

/** Order within the single eligibility set: priority, then new-before-old within a priority, then
 *  oldest. `since` is the "new" boundary, bound as the `?` in the new-first CASE. */
const CANDIDATE_ORDER = `ORDER BY ${PRIORITY_RANK},
  CASE WHEN t.created_at >= ? THEN 0 ELSE 1 END, t.created_at ASC, t.id ASC`;

/** New eligible tickets (created at/after the boundary) still waiting for a session. */
export function autostartQueue(db: Database.Database, since: number, repo: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM agent_tickets t WHERE ${ELIGIBLE_WHERE} AND t.created_at >= ?`).get(repo, since) as {
      n: number;
    }
  ).n;
}

/** Older eligible tickets (created before the boundary) still waiting, published alongside the new
 *  count so the two halves of the one list stay legible. */
export function backfillRemaining(db: Database.Database, since: number, repo: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM agent_tickets t WHERE ${ELIGIBLE_WHERE} AND t.created_at < ?`).get(repo, since) as {
      n: number;
    }
  ).n;
}

/** The next ticket to auto-refine across the whole eligibility set, or null. */
export function nextAutostartCandidate(
  db: Database.Database,
  since: number,
  repo: string,
): { id: number; displayId: string | null; title: string; body: string | null } | null {
  const row = db
    .prepare(`SELECT t.id, t.display_id, t.title, t.body FROM agent_tickets t WHERE ${ELIGIBLE_WHERE} ${CANDIDATE_ORDER} LIMIT 1`)
    .get(repo, since) as { id: number; display_id: string | null; title: string; body: string | null } | undefined;
  return row ? { id: row.id, displayId: row.display_id, title: row.title, body: row.body } : null;
}

/** Write the kickoff turn — the same `title\n\nbody` the Refine button writes (server
 *  `startRefine`) — marked `auto` so the thread can say who started it. */
export function writeAutostartKickoff(
  db: Database.Database,
  ticket: { id: number; title: string; body: string | null },
  now: number,
): void {
  const text = [ticket.title, ticket.body ?? ''].join('\n\n').trim();
  db.prepare('INSERT INTO agent_ticket_events (ticket_id, type, detail, created_at) VALUES (?, ?, ?, ?)').run(
    ticket.id,
    REFINE_EVENT_TYPE.human,
    JSON.stringify({ text, auto: true }),
    now,
  );
}

/**
 * One scheduler cycle: start at most one session, and publish the scheduler's state for system
 * status. Returns the ticket id started, or null.
 */
export function runAutostart(db: Database.Database, config: AutostartConfig, now: number): number | null {
  const open = openSessionCount(db);
  let backfill = 0;
  const publish = (queued: number, heldBy: string | null) => {
    const status: RefineAutostartStatus = {
      enabled: config.enabled,
      open,
      cap: config.openCap,
      queued,
      backfillRemaining: backfill,
      heldBy,
      at: now,
    };
    writeState(db, REFINE_AUTOSTART_STATUS_KEY, JSON.stringify(status), now);
  };

  if (!config.enabled) {
    publish(0, 'auto-start is off (REFINE_AUTOSTART_ENABLED)');
    return null;
  }
  const since = autostartSince(db, now);
  const queued = autostartQueue(db, since, config.repo);
  backfill = backfillRemaining(db, since, config.repo);

  const hold = activeSessionLimitHold(db, now);
  if (hold) {
    publish(queued, 'provider session limit');
    return null;
  }
  if (isDispatchPaused(db)) {
    publish(queued, 'Robot dispatch is paused (budget or fault); resume the loop to resume auto-start');
    return null;
  }
  if (open >= config.openCap) {
    publish(queued, `${open} sessions open, at the cap of ${config.openCap}; answer some to free a slot`);
    return null;
  }

  // One priority-ordered list (T1011): highest priority first, new-before-old within a priority.
  const candidate = nextAutostartCandidate(db, since, config.repo);
  if (!candidate) {
    publish(0, null);
    return null;
  }
  writeAutostartKickoff(db, candidate, now);
  backfill = backfillRemaining(db, since, config.repo);
  publish(autostartQueue(db, since, config.repo), null);
  logger.info({ ticketId: candidate.id, displayId: candidate.displayId, open: open + 1 }, 'refine: auto-started a session');
  return candidate.id;
}
