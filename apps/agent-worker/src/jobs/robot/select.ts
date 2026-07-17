import type Database from 'better-sqlite3';
import { isSortieReady } from '@dashboard/shared';
import type { RobotConfig } from '../../shared/config';

/**
 * Dispatch selection for the Robot loop (D-055, PD-342). The board DB is the queue: a ticket
 * is dispatchable when it sits in the `robot_queue` lane of a sortie-enabled project with a
 * repo, its body is Sortie-ready (has the four sections), and it is not blocked by an open
 * `blocks` relation (dogfooding D-051 — the same gate the board enforces on lane entry).
 *
 * The SQL mirrors the server store's `listQueuedIssueTargets` so the loop and the board agree
 * on what "queued for a robot" means; the not-blocked + ready + allowlist filters run on top.
 */

export interface RobotCandidate {
  id: number;
  issueNumber: number | null;
  repo: string;
  title: string;
  body: string | null;
}

interface CandidateRow {
  id: number;
  n: number | null;
  repo: string;
  title: string;
  body: string | null;
}

/** Tickets in `robot_queue` of a sortie-enabled repo project — the raw candidate set. A ticket
 *  blocked by an unresolved `blocks` relation is excluded here (D-051): a `blocks` row is
 *  `from`=blocker → `to`=blocked, so `t` is blocked when it is some open blocker's `to` end.
 *
 *  The `agent_state` gate is what stops re-dispatch: `robot_queue` is a single lane whose
 *  sub-state lives in `agent_state`, so a ticket stays in `robot_queue` while working and after
 *  hand-off. Only a fresh ticket (NULL or `queued`) is dispatchable; the loop sets `working` on
 *  dispatch and `in-review` on hand-off, both of which drop it out of this set. */
export function robotQueueCandidates(db: Database.Database): RobotCandidate[] {
  const rows = db
    .prepare(
      `SELECT t.id AS id, t.github_issue_number AS n, t.title AS title, t.body AS body, p.github_repo AS repo
         FROM agent_tickets t
         JOIN agent_projects p ON p.id = t.project_id
        WHERE t.archived_at IS NULL
          AND t.status = 'robot_queue'
          AND (t.agent_state IS NULL OR t.agent_state = 'queued')
          AND p.sortie_enabled = 1
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
    .all() as CandidateRow[];
  return rows.map((r) => ({ id: r.id, issueNumber: r.n, repo: r.repo, title: r.title, body: r.body }));
}

/**
 * Decide which candidates the Robot loop may dispatch THIS cycle, given the current in-flight
 * count. Pure so it is unit-tested directly. Applies, in order:
 *  1. dispatch must be enabled;
 *  2. dispatch scope (C6/PD-347): `'none'` ⇒ nothing (killswitch); an id list ⇒ only those
 *     (prove-on-N); `'all'` ⇒ no id restriction (go-live default);
 *  3. body must be Sortie-ready (defensive — robot_queue entry already checks this);
 *  4. concurrency cap (leave room for `concurrency - inFlight` new Robots).
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
  const eligible = candidates.filter((c) => isSortieReady(c.body) && inScope(c.id));

  const slots = Math.max(0, config.concurrency - inFlight);
  return eligible.slice(0, slots);
}
