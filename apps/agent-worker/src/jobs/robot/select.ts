import type Database from 'better-sqlite3';
import type { TicketPriority } from '@dashboard/shared';
import type { RobotConfig } from '../../shared/config';

/**
 * Dispatch selection for the Robot loop (D-055, PD-342; D-058 queue model). The board DB is the
 * queue: a ticket is dispatchable when it sits in the single `queue` lane, is assigned to `robot`,
 * is Ready or ready-bypassed (`ready = 1 OR ready_bypassed = 1` — read from the persisted flags,
 * D-058: a flag read instead of a body parse), belongs to a robot-enabled project with a repo, and
 * is not blocked by an open `blocks` relation (dogfooding D-051 — the same gate the board enforces
 * on lane entry).
 *
 * The SQL mirrors the server store's `listQueuedIssueTargets` so the loop and the board agree on
 * what "queued for a robot" means; the not-blocked + allowlist filters run on top.
 */

export interface RobotCandidate {
  id: number;
  issueNumber: number | null;
  repo: string;
  title: string;
  body: string | null;
  /** P0–P5, or null when unset. Carried so the dispatch order is observable in logs (PD-294). */
  priority: TicketPriority | null;
  /** Per-ticket run ceiling (PD-432); null ⇒ use the loop's env default. */
  maxTurns: number | null;
}

interface CandidateRow {
  id: number;
  n: number | null;
  repo: string;
  title: string;
  body: string | null;
  /** RAW column value — 'P0'…'P5' or the `'none'` sentinel, not the domain `null`. */
  priority: string | null;
  max_turns: number | null;
}

/** How `agent_tickets.priority` stores "unset": the column is `TEXT NOT NULL DEFAULT 'none'`
 *  (server `schema.ts`), so unset is this sentinel and never SQL NULL. Mirrors `PRIORITY_UNSET`
 *  in the server store, which maps it to `null` at the API boundary. */
const PRIORITY_UNSET = 'none';

/** Tickets in `queue` assigned to `robot` and Ready (or ready-bypassed) of a robot-enabled repo
 *  project — the raw candidate set (D-058). A ticket blocked by an unresolved `blocks` relation is
 *  excluded here (D-051): a `blocks` row is `from`=blocker → `to`=blocked, so `t` is blocked when
 *  it is some open blocker's `to` end.
 *
 *  The `agent_state` gate is what stops re-dispatch: `queue` is a single lane whose sub-state lives
 *  in `agent_state`, so a ticket stays in `queue` while working and after hand-off. Only a fresh
 *  ticket (NULL or `queued`) is dispatchable; the loop sets `working` on dispatch and `in-review`
 *  on hand-off, both of which drop it out of this set.
 *
 *  Ordered by **priority, then the Epic's rank, then the member's drag order, then id** (PD-294;
 *  D-076). 'P0'…'P5' compare correctly under plain lexical ASC, so no mapping table is needed.
 *  Unset priority sorts *last* via the CASE — absent priority means "unclassified", not "most
 *  urgent". Previously this was `ORDER BY t.id ASC`, which dispatched purely oldest-first: a P0
 *  queued today waited behind a P5 queued last month.
 *
 *  **D-076 adds the two middle keys, and they are load-bearing.** Priority is now an Epic property
 *  cascaded to its members, so `t.priority` already *is* the Epic's priority — no join is needed to
 *  rank Epics against each other. But that also means every member of an Epic ties on priority, and
 *  without a further key the only discriminator left would be `t.id`, i.e. the order the tickets
 *  happened to be created in. `e.sort_order` breaks ties *between* equal-priority Epics (their drag
 *  order on the board is what says which is next); `t.sort_order` is the member's drag order *within*
 *  its Epic, which is how order-of-operations is expressed now that `blocks` is reserved for true
 *  dependencies. A ticket with no Epic sorts as if its Epic ranked 0.
 *
 *  NOTE the storage representation: `agent_tickets.priority` is `TEXT NOT NULL DEFAULT 'none'`, so
 *  **unset is the sentinel string `'none'`, never SQL NULL** (schema.ts). The server store maps
 *  'none' ↔ `null` at the API boundary; this query reads the raw column, so it must test the
 *  sentinel — a `priority IS NULL` check would silently never fire, and ~⅓ of the board is unset.
 *  We map the sentinel back to `null` on the way out so `RobotCandidate.priority` matches the
 *  domain type. */
export function robotQueueCandidates(db: Database.Database): RobotCandidate[] {
  const rows = db
    .prepare(
      `SELECT t.id AS id, t.github_issue_number AS n, t.title AS title, t.body AS body,
              t.priority AS priority, t.max_turns AS max_turns, p.github_repo AS repo
         FROM agent_tickets t
         JOIN agent_projects p ON p.id = t.project_id
         LEFT JOIN agent_tickets e ON e.id = t.epic_id
        WHERE t.archived_at IS NULL
          AND t.status = 'queue'
          AND t.assignee = 'robot'
          AND (t.ready = 1 OR t.ready_bypassed = 1)
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
          )
        ORDER BY CASE WHEN t.priority IS NULL OR t.priority = ? THEN 1 ELSE 0 END,
                 t.priority ASC,
                 COALESCE(e.sort_order, 0) ASC,
                 t.sort_order ASC,
                 t.id ASC`,
    )
    .all(PRIORITY_UNSET) as CandidateRow[];
  return rows.map((r) => ({
    id: r.id,
    issueNumber: r.n,
    repo: r.repo,
    title: r.title,
    body: r.body,
    priority: r.priority === null || r.priority === PRIORITY_UNSET ? null : (r.priority as TicketPriority),
    maxTurns: r.max_turns,
  }));
}

/** A queued ticket that passes every dispatch gate EXCEPT its `agent_state` (PD-467). */
export interface BlockedByAgentState {
  id: number;
  agentState: string;
}

/**
 * Tickets that would be dispatchable but for a parked `agent_state` (PD-467). Same gates as
 * `robotQueueCandidates` — `queue` + `assignee=robot` + Ready + robot-enabled repo + unblocked —
 * with the `agent_state` test inverted, and `working`/`in-review` excluded because those are the
 * states the loop itself sets on a healthy run (a Robot mid-flight or a PR awaiting review is not a
 * trap). What is left is a card that looks perfectly normal in the Queue and can never dispatch.
 *
 * `updateTicket` now clears `stuck`/`needs-human` on queue entry, so the trap should be
 * unreachable from the board — this exists because "should be unreachable" is exactly the claim
 * that goes stale. A silently-skipped ticket is indistinguishable from an idle loop, which is the
 * failure mode that is hardest to notice when the loop is turned back on.
 */
export function queuedBlockedByAgentState(db: Database.Database): BlockedByAgentState[] {
  return db
    .prepare(
      `SELECT t.id AS id, t.agent_state AS agentState
         FROM agent_tickets t
         JOIN agent_projects p ON p.id = t.project_id
        WHERE t.archived_at IS NULL
          AND t.status = 'queue'
          AND t.assignee = 'robot'
          AND (t.ready = 1 OR t.ready_bypassed = 1)
          AND t.agent_state IS NOT NULL
          AND t.agent_state NOT IN ('queued', 'working', 'in-review')
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
          )
        ORDER BY t.id ASC`,
    )
    .all() as BlockedByAgentState[];
}

/**
 * Decide which candidates the Robot loop may dispatch THIS cycle, given the current in-flight
 * count. Pure so it is unit-tested directly. Applies, in order:
 *  1. dispatch must be enabled;
 *  2. dispatch scope (C6/PD-347): `'none'` ⇒ nothing (killswitch); an id list ⇒ only those
 *     (prove-on-N); `'all'` ⇒ no id restriction (go-live default);
 *  3. concurrency cap (leave room for `concurrency - inFlight` new Robots).
 *
 * D-058: the ready check is no longer re-parsed here — `ready`/`ready_bypassed` are persisted
 * columns already filtered in `robotQueueCandidates`'s SQL (a flag read, not a body parse).
 */
export function selectDispatchable(
  candidates: RobotCandidate[],
  config: RobotConfig,
  inFlight: number,
): RobotCandidate[] {
  if (!config.dispatchEnabled) return [];
  if (config.allowlist === 'none') return [];

  const { allowlist } = config;
  const inScope = (id: number): boolean => allowlist === 'all' || allowlist.includes(id);
  const eligible = candidates.filter((c) => inScope(c.id));

  const slots = Math.max(0, config.concurrency - inFlight);
  return eligible.slice(0, slots);
}
