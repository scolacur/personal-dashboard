import type Database from 'better-sqlite3';
import type { CoderArea, TicketPriority } from '@dashboard/shared';
import { effectiveCoderArea, isCoderArea } from '@dashboard/shared';
import type { RobotConfig } from '../../shared/config';

/**
 * Dispatch selection for the Robot loop (D-055, PD-342; D-058 queue model). The board DB is the
 * queue: a ticket is dispatchable when it sits in the single `queue` lane, is assigned to `robot`,
 * is Ready or ready-bypassed (`ready = 1 OR ready_bypassed = 1` — read from the persisted flags,
 * D-058: a flag read instead of a body parse), is refined (`refined = 1`, D-091), belongs to a robot-enabled project with a repo, and
 * is not blocked by an open `blocks` relation (dogfooding D-051 — the same gate the board enforces
 * on lane entry).
 *
 * The SQL mirrors the server store's `listQueuedIssueTargets` so the loop and the board agree on
 * what "queued for a robot" means; the not-blocked + allowlist filters run on top.
 */

export interface RobotCandidate {
  id: number;
  issueNumber: number | null;
  /** The ticket's display id (e.g. `PD-725`), or null when unset. Carried into the task prompt so a
   *  Robot PR names its ticket in the title and a `**Ticket:**` body line (the `robot/t<id>` branch
   *  only carries the internal numeric id). */
  displayId: string | null;
  repo: string;
  title: string;
  body: string | null;
  /** P0–P5, or null when unset. Carried so the dispatch order is observable in logs (PD-294). */
  priority: TicketPriority | null;
  /** Per-ticket run ceiling (PD-432); null ⇒ use the loop's env default. */
  maxTurns: number | null;
  /** The code area a Coder would run this ticket under (PD-880/PD-951): the ticket's own override,
   *  then its Epic's default, then `general`. The per-area concurrency cap keys off this. */
  coderArea: CoderArea;
}

interface CandidateRow {
  id: number;
  n: number | null;
  display_id: string | null;
  repo: string;
  title: string;
  body: string | null;
  /** RAW column value — 'P0'…'P5' or the `'none'` sentinel, not the domain `null`. */
  priority: string | null;
  max_turns: number | null;
  /** RAW `coder_area` column — a CoderArea id or NULL (unset). Resolved via `effectiveCoderArea`. */
  coder_area: string | null;
  /** RAW `coder_area` of the ticket's Epic (via the LEFT JOIN), or NULL. */
  epic_coder_area: string | null;
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
 *  D-080). 'P0'…'P5' compare correctly under plain lexical ASC, so no mapping table is needed.
 *  Unset priority sorts *last* via the CASE — absent priority means "unclassified", not "most
 *  urgent". Previously this was `ORDER BY t.id ASC`, which dispatched purely oldest-first: a P0
 *  queued today waited behind a P5 queued last month.
 *
 *  **D-080 adds the two middle keys, and they are load-bearing.** Priority is now an Epic property
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
 *  domain type.
 *
 *  **`t.refined = 1` is a backstop, not the gate (D-091).** The server refuses robot work entering
 *  the Queue unrefined at every door it owns; this catches the one case it cannot — a ticket
 *  un-refined *after* it was queued. It deliberately checks only the ticket's own flag: the Epic-level
 *  criteria are enforced on entry, and a going-stale Epic already un-arms its members (D-089 §6), so
 *  repeating them here would only widen the query D-089 asked to keep narrow. A ticket this skips is
 *  named every cycle by `queuedButUnrefined`, so the skip is never silent. */
export function robotQueueCandidates(db: Database.Database): RobotCandidate[] {
  const rows = db
    .prepare(
      `SELECT t.id AS id, t.github_issue_number AS n, t.display_id AS display_id, t.title AS title, t.body AS body,
              t.priority AS priority, t.max_turns AS max_turns, t.coder_area AS coder_area, e.coder_area AS epic_coder_area,
              p.github_repo AS repo
         FROM agent_tickets t
         JOIN agent_projects p ON p.id = t.project_id
         LEFT JOIN agent_tickets e ON e.id = t.epic_id
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
    displayId: r.display_id,
    repo: r.repo,
    title: r.title,
    body: r.body,
    priority: r.priority === null || r.priority === PRIORITY_UNSET ? null : (r.priority as TicketPriority),
    maxTurns: r.max_turns,
    coderArea: effectiveCoderArea(
      { coderArea: isCoderArea(r.coder_area) ? r.coder_area : null },
      { coderArea: isCoderArea(r.epic_coder_area) ? r.epic_coder_area : null },
    ),
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
 *
 * `checkpoint` (D-094/PD-737) is excluded too: it is a deliberate park the loop set and surfaced, and
 * it is resolved by Continue/Restart — not by the "Unstick to clear" this warning advises.
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
          AND t.refined = 1
          AND t.agent_state IS NOT NULL
          AND t.agent_state NOT IN ('queued', 'working', 'in-review', 'checkpoint')
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
 * Queued robot tickets the selection query skips purely because they are no longer refined (D-091).
 *
 * Reachable only by un-refining a ticket after it entered the Queue — the server refuses it on the
 * way in. Same idea as `queuedBlockedByAgentState`: a skipped card looks exactly like an idle loop,
 * so it is named rather than left to be noticed. Not Ready / blocked / parked tickets are left to
 * their own gates and diagnostics, so each skip is reported for one reason only.
 */
export function queuedButUnrefined(db: Database.Database): { id: number }[] {
  return db
    .prepare(
      `SELECT t.id AS id
         FROM agent_tickets t
         JOIN agent_projects p ON p.id = t.project_id
        WHERE t.archived_at IS NULL
          AND t.status = 'queue'
          AND t.assignee = 'robot'
          AND t.refined = 0
          AND (t.agent_state IS NULL OR t.agent_state = 'queued')
          AND p.robot_enabled = 1
          AND p.github_repo IS NOT NULL
        ORDER BY t.id ASC`,
    )
    .all() as { id: number }[];
}

/**
 * PD-951: the per-code-area concurrency cap — at most one Coder per {@link CoderArea} at a time.
 * A named constant, NOT a config knob: the whole point is that overall parallelism comes only from
 * *different* areas running at once, and `general` is capped like any other area. The global
 * `ROBOT_CONCURRENCY` still applies on top (it bounds the total across all areas). Together with
 * PD-880 this is what lets PD-512 raise the global cap without two Coders fighting over one area.
 */
export const PER_AREA_CONCURRENCY = 1;

/**
 * How many Coders are currently RUNNING in each code area (PD-951) — the areas already occupied
 * when selection runs. Keyed on the SAME `effectiveCoderArea` resolution the candidates use, so a
 * running run and a queued candidate agree on what area they belong to. A rework is an ordinary
 * `running` run row, so it counts toward its ticket's area like any other (per the ticket).
 *
 * Tolerates a pre-run table (worker booted before `agent_runs` exists) → an empty map, so a cold
 * boot never throws here; it just sees no area as busy yet.
 */
export function runningCoderAreas(db: Database.Database): Map<CoderArea, number> {
  const counts = new Map<CoderArea, number>();
  try {
    const rows = db
      .prepare(
        `SELECT t.coder_area AS coder_area, e.coder_area AS epic_coder_area
           FROM agent_runs r
           JOIN agent_tickets t ON t.id = r.ticket_id
           LEFT JOIN agent_tickets e ON e.id = t.epic_id
          WHERE r.status = 'running'`,
      )
      .all() as { coder_area: string | null; epic_coder_area: string | null }[];
    for (const r of rows) {
      const area = effectiveCoderArea(
        { coderArea: isCoderArea(r.coder_area) ? r.coder_area : null },
        { coderArea: isCoderArea(r.epic_coder_area) ? r.epic_coder_area : null },
      );
      counts.set(area, (counts.get(area) ?? 0) + 1);
    }
  } catch {
    return counts;
  }
  return counts;
}

/** A candidate held out of this cycle specifically because its code area is already busy (PD-951) —
 *  distinct from one merely over the global concurrency cap. Reported so the skip is never silent. */
export interface AreaBusySkip {
  id: number;
  area: CoderArea;
  /** The human-facing reason, matching the other "why a ready ticket isn't dispatching" surfaces. */
  reason: string;
}

interface DispatchPlan {
  dispatch: RobotCandidate[];
  areaBusy: AreaBusySkip[];
}

/**
 * The single pass that decides, for one cycle, which eligible candidates dispatch and which are held
 * back for their area (PD-951). Applies, in order:
 *  1. dispatch must be enabled;
 *  2. dispatch scope (C6/PD-347): `'none'` ⇒ nothing (killswitch); an id list ⇒ only those
 *     (prove-on-N); `'all'` ⇒ no id restriction (go-live default);
 *  3. per-area cap: skip a candidate whose {@link CoderArea} already has `PER_AREA_CONCURRENCY`
 *     Coders running (from `runningAreas`) or claimed earlier in THIS cycle;
 *  4. global concurrency cap (leave room for `concurrency - inFlight` new Robots).
 *
 * Candidates are examined in the priority order `robotQueueCandidates` returns, so the highest-
 * priority ticket in each area wins the area's one slot. A candidate only reaches the area check
 * while a global slot is still free; once the global cap binds, the rest are waiting on capacity,
 * not on their area, so they are not reported as area-busy.
 *
 * D-058: the ready check is no longer re-parsed here — `ready`/`ready_bypassed` are persisted
 * columns already filtered in `robotQueueCandidates`'s SQL (a flag read, not a body parse).
 */
function planDispatch(
  candidates: RobotCandidate[],
  config: RobotConfig,
  inFlight: number,
  runningAreas: ReadonlyMap<CoderArea, number>,
): DispatchPlan {
  if (!config.dispatchEnabled) return { dispatch: [], areaBusy: [] };
  if (config.allowlist === 'none') return { dispatch: [], areaBusy: [] };

  const { allowlist } = config;
  const inScope = (id: number): boolean => allowlist === 'all' || allowlist.includes(id);
  const eligible = candidates.filter((c) => inScope(c.id));

  let slots = Math.max(0, config.concurrency - inFlight);
  const areaCount = new Map<CoderArea, number>(runningAreas);
  const dispatch: RobotCandidate[] = [];
  const areaBusy: AreaBusySkip[] = [];

  for (const c of eligible) {
    const used = areaCount.get(c.coderArea) ?? 0;
    if (used >= PER_AREA_CONCURRENCY) {
      areaBusy.push({ id: c.id, area: c.coderArea, reason: `waiting: area ${c.coderArea} busy` });
      continue;
    }
    if (slots <= 0) break; // global concurrency cap reached — the rest wait on capacity, not area
    dispatch.push(c);
    areaCount.set(c.coderArea, used + 1);
    slots -= 1;
  }
  return { dispatch, areaBusy };
}

/**
 * Which candidates the Robot loop may dispatch THIS cycle, given the current in-flight count and the
 * areas already running. Pure so it is unit-tested directly. See {@link planDispatch} for the rules.
 */
export function selectDispatchable(
  candidates: RobotCandidate[],
  config: RobotConfig,
  inFlight: number,
  runningAreas: ReadonlyMap<CoderArea, number> = new Map(),
): RobotCandidate[] {
  return planDispatch(candidates, config, inFlight, runningAreas).dispatch;
}

/**
 * The candidates {@link selectDispatchable} held back purely because their code area was already
 * busy (PD-951) — so the loop can name them, exactly as it names `queuedBlockedByAgentState` and
 * `queuedButUnrefined`. A ticket merely over the global concurrency cap is NOT here; the reason it
 * waits is capacity, not its area.
 */
export function areaBusySkips(
  candidates: RobotCandidate[],
  config: RobotConfig,
  inFlight: number,
  runningAreas: ReadonlyMap<CoderArea, number> = new Map(),
): AreaBusySkip[] {
  return planDispatch(candidates, config, inFlight, runningAreas).areaBusy;
}
