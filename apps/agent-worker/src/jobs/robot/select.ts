import type Database from 'better-sqlite3';
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
}

interface CandidateRow {
  id: number;
  n: number | null;
  repo: string;
  title: string;
  body: string | null;
}

/** Tickets in `queue` assigned to `robot` and Ready (or ready-bypassed) of a robot-enabled repo
 *  project — the raw candidate set (D-058). A ticket blocked by an unresolved `blocks` relation is
 *  excluded here (D-051): a `blocks` row is `from`=blocker → `to`=blocked, so `t` is blocked when
 *  it is some open blocker's `to` end.
 *
 *  The `agent_state` gate is what stops re-dispatch: `queue` is a single lane whose sub-state lives
 *  in `agent_state`, so a ticket stays in `queue` while working and after hand-off. Only a fresh
 *  ticket (NULL or `queued`) is dispatchable; the loop sets `working` on dispatch and `in-review`
 *  on hand-off, both of which drop it out of this set. */
export function robotQueueCandidates(db: Database.Database): RobotCandidate[] {
  const rows = db
    .prepare(
      `SELECT t.id AS id, t.github_issue_number AS n, t.title AS title, t.body AS body, p.github_repo AS repo
         FROM agent_tickets t
         JOIN agent_projects p ON p.id = t.project_id
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
