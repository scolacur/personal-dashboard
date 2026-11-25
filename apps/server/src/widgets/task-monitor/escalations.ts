import type Database from 'better-sqlite3';
import {
  OPEN_PRS_SNAPSHOT_KEY,
  ROBOT_EVENT,
  type AwaitingEscalationItem,
  type EscalationLensReport,
  type EscalationReason,
  type EvaluatorFinding,
  type EvaluatorLens,
  type EvaluatorVerdict,
  type OpenPrsSnapshot,
} from '@dashboard/shared';

/**
 * The Decisions inbox's Escalations section (PD-1007): every open PR the Evaluator handed back to
 * Steve, derived from the DB alone. Nothing here touches GitHub.
 *
 * An escalation is the failure branch of the worker's `gateForOutcome`
 * (`apps/agent-worker/src/jobs/evaluate/review-gate.ts`), read from `evaluator_runs` for the PR's
 * current review cycle, every lens settled:
 *  - `escalate`: a lens's latest verdict is `escalate`;
 *  - `round-cap`: the combined verdict is `revise` at the round cap;
 *  - `no-verdict`: a lens has no verdict and has used its one retry (two errored runs).
 * A lens still owing a run (in flight, or one error with its retry pending) means the cycle has not
 * decided yet, so the PR is not listed.
 *
 * The cycle is the worker's, per path:
 *  - **Robot** PRs (ticket `in-review`, the PR of its last hand-off): runs since `reviewBoundary`,
 *    the latest hand-off, conflict resolution or skipped rework (Robot runs leave `head_sha` null).
 *    A revise left in-review means the cap, because below it the worker re-queues the ticket.
 *  - **Session** PRs: runs on the PR's current head (`head_sha`), round = distinct heads reviewed.
 *
 * Open, merged, closed and approved come from the open-PR snapshot the worker writes each Evaluator
 * pass (`OPEN_PRS_SNAPSHOT_KEY`). A PR leaves the section when it is no longer in the snapshot
 * (merged or closed), Steve approved it, or a new head starts a new cycle.
 */

const LENS_ORDER: EvaluatorLens[] = ['code', 'security'];
/** The worker's "one retry" (MAX_LENS_ERROR_RUNS): a lens with this many errored runs and no
 *  verdict is settled as no-verdict. */
const MAX_LENS_ERROR_RUNS = 2;
/** Rows that count: a run a worker restart killed says nothing about the PR (PD-919). */
const COUNTED = "(error IS NULL OR error NOT LIKE 'interrupted:%')";

export interface RunRow {
  id: number;
  ticket_id: number;
  pr_number: number;
  round: number;
  verdict: EvaluatorVerdict | null;
  findings: string | null;
  summary: string | null;
  lens: string | null;
  started_at: number;
  finished_at: number | null;
}

const RUN_COLUMNS = 'id, ticket_id, pr_number, round, verdict, findings, summary, lens, started_at, finished_at';

const tableExists = (db: Database.Database, name: string): boolean =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

function parseFindings(raw: string | null): EvaluatorFinding[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as EvaluatorFinding[]) : [];
  } catch {
    return [];
  }
}

/** The worker's open-PR snapshot, or null when it has never written one (all-PRs review off). */
export function readOpenPrsSnapshot(db: Database.Database): (OpenPrsSnapshot & { at: number }) | null {
  if (!tableExists(db, 'robot_state')) return null;
  const row = db.prepare('SELECT value, updated_at FROM robot_state WHERE key = ?').get(OPEN_PRS_SNAPSHOT_KEY) as
    | { value: string | null; updated_at: number }
    | undefined;
  if (!row?.value) return null;
  try {
    const v = JSON.parse(row.value) as OpenPrsSnapshot;
    if (!Array.isArray(v.prs) || typeof v.maxRounds !== 'number') return null;
    return { ...v, at: row.updated_at };
  } catch {
    return null;
  }
}

export interface CycleDecision {
  /** null when the cycle is undecided or not a "needs Steve" failure. */
  reason: EscalationReason | null;
  round: number;
  lenses: EscalationLensReport[];
  escalatedAt: number;
}

/**
 * Pure: the combined decision over one review cycle's runs. `isCap(round)` says whether a combined
 * revise at `round` is at the round cap.
 */
export function decideCycle(counted: readonly RunRow[], isCap: (round: number) => boolean): CycleDecision {
  const empty: CycleDecision = { reason: null, round: 0, lenses: [], escalatedAt: 0 };
  if (counted.length === 0) return empty;
  // A run still open means a review is in flight: the gate is "reviewing", not a decision.
  if (counted.some((r) => r.finished_at === null)) return empty;

  const byLens = new Map<EvaluatorLens, RunRow[]>();
  for (const r of counted) {
    const lens = (r.lens ?? 'code') as EvaluatorLens;
    byLens.set(lens, [...(byLens.get(lens) ?? []), r]);
  }
  const lenses: EscalationLensReport[] = [];
  let noVerdict = false;
  for (const lens of [...byLens.keys()].sort((a, b) => LENS_ORDER.indexOf(a) - LENS_ORDER.indexOf(b))) {
    const rows = byLens.get(lens)!;
    const verdicts = rows.filter((r) => r.verdict !== null).sort((a, b) => a.started_at - b.started_at || a.id - b.id);
    const latest = verdicts[verdicts.length - 1];
    if (latest) {
      lenses.push({
        lens,
        verdict: latest.verdict,
        summary: latest.summary ?? '',
        blockingFindings: parseFindings(latest.findings)
          .filter((f) => f.blocking)
          .map((f) => ({ kind: f.kind, where: f.where ?? '', what: f.what ?? '' })),
      });
      continue;
    }
    const errors = rows.length;
    if (errors < MAX_LENS_ERROR_RUNS) return empty; // its one retry is still pending
    noVerdict = true;
    lenses.push({ lens, verdict: null, summary: '', blockingFindings: [] });
  }

  const round = Math.max(...counted.map((r) => r.round));
  const escalatedAt = Math.max(...counted.map((r) => r.finished_at ?? r.started_at));
  const verdicts = lenses.map((l) => l.verdict);
  let reason: EscalationReason | null = null;
  if (noVerdict) reason = 'no-verdict';
  else if (verdicts.includes('escalate')) reason = 'escalate';
  else if (verdicts.includes('revise') && isCap(round)) reason = 'round-cap';
  return { reason, round, lenses, escalatedAt };
}

interface Ev {
  type: string;
  detail: string | null;
  created_at: number;
}

const prFromUrl = (url: string | undefined): number | null => {
  const m = /\/pull\/(\d+)/.exec(url ?? '');
  return m ? Number(m[1]) : null;
};

interface TicketRow {
  id: number;
  display_id: string | null;
  title: string;
  repo: string | null;
}

const prUrlFor = (repo: string | null, prNumber: number) => (repo ? `https://github.com/${repo}/pull/${prNumber}` : null);

/** Robot PRs: every in-review, non-terminal Robot ticket's hand-off PR, judged over its cycle. */
function robotEscalations(db: Database.Database, snapshot: ReturnType<typeof readOpenPrsSnapshot>): AwaitingEscalationItem[] {
  const tickets = db
    .prepare(
      `SELECT t.id, t.display_id, t.title, p.github_repo AS repo
         FROM agent_tickets t LEFT JOIN agent_projects p ON p.id = t.project_id
        WHERE t.archived_at IS NULL AND t.assignee = 'robot' AND t.agent_state = 'in-review'
          AND t.status NOT IN ('completed', 'closed')`,
    )
    .all() as TicketRow[];
  const out: AwaitingEscalationItem[] = [];
  for (const t of tickets) {
    const events = db
      .prepare(
        `SELECT type, detail, created_at FROM agent_ticket_events
          WHERE ticket_id = ? AND type IN (?, ?, ?) ORDER BY created_at, id`,
      )
      .all(t.id, ROBOT_EVENT.handoff, ROBOT_EVENT.conflictResolved, ROBOT_EVENT.reworkSkipped) as Ev[];
    const handoffs = events.filter((e) => e.type === ROBOT_EVENT.handoff);
    const last = handoffs[handoffs.length - 1];
    if (!last) continue;
    let prUrl: string | null = null;
    try {
      prUrl = (JSON.parse(last.detail ?? '{}') as { prUrl?: string }).prUrl ?? null;
    } catch {
      prUrl = null;
    }
    const prNumber = prFromUrl(prUrl ?? undefined);
    if (prNumber === null) continue;
    const boundary = Math.max(...events.map((e) => e.created_at));
    const runs = db
      .prepare(
        `SELECT ${RUN_COLUMNS} FROM evaluator_runs
          WHERE ticket_id = ? AND pr_number = ? AND started_at >= ? AND ${COUNTED}`,
      )
      .all(t.id, prNumber, boundary) as RunRow[];
    // Below the cap a revise re-queues the ticket, so a revise still in-review is at the cap.
    const d = decideCycle(runs, (round) => (snapshot ? round >= snapshot.maxRounds : true));
    if (!d.reason) continue;
    // The snapshot judges open/approved only when it was taken at or after the escalation's pass
    // (the worker lists before it reviews, with the same clock); an older one predates the PR's state.
    if (snapshot && snapshot.at >= Math.min(...runs.map((r) => r.started_at))) {
      const seen = snapshot.prs.find((p) => p.number === prNumber);
      if (!seen || seen.approved) continue;
    }
    out.push({
      prNumber,
      prUrl: prUrl ?? prUrlFor(t.repo, prNumber),
      ticket: { id: t.id, displayId: t.display_id, title: t.title },
      path: 'robot',
      reason: d.reason,
      round: d.round,
      lenses: d.lenses,
      escalatedAt: d.escalatedAt,
    });
  }
  return out;
}

/** Session PRs: each open, unapproved PR in the snapshot, judged over the runs on its current head. */
function sessionEscalations(
  db: Database.Database,
  snapshot: NonNullable<ReturnType<typeof readOpenPrsSnapshot>>,
  robotPrs: ReadonlySet<number>,
): AwaitingEscalationItem[] {
  const repoRow = db
    .prepare("SELECT github_repo AS repo FROM agent_projects WHERE key = 'PD' AND github_repo IS NOT NULL")
    .get() as { repo: string } | undefined;
  const out: AwaitingEscalationItem[] = [];
  for (const pr of snapshot.prs) {
    if (pr.approved || robotPrs.has(pr.number)) continue;
    const runs = db
      .prepare(`SELECT ${RUN_COLUMNS} FROM evaluator_runs WHERE pr_number = ? AND head_sha = ? AND ${COUNTED}`)
      .all(pr.number, pr.headSha) as RunRow[];
    // A new head with no review yet has no runs here, so it drops out: the new cycle has not decided.
    const d = decideCycle(runs, (round) => round >= snapshot.maxRounds);
    if (!d.reason) continue;
    const ticketId = runs.find((r) => r.ticket_id > 0)?.ticket_id ?? null;
    const t =
      ticketId !== null
        ? (db
            .prepare(
              `SELECT t.id, t.display_id, t.title, p.github_repo AS repo
                 FROM agent_tickets t LEFT JOIN agent_projects p ON p.id = t.project_id WHERE t.id = ?`,
            )
            .get(ticketId) as TicketRow | undefined)
        : undefined;
    out.push({
      prNumber: pr.number,
      prUrl: prUrlFor(t?.repo ?? repoRow?.repo ?? null, pr.number),
      ticket: t ? { id: t.id, displayId: t.display_id, title: t.title } : null,
      path: 'session',
      reason: d.reason,
      round: d.round,
      lenses: d.lenses,
      escalatedAt: d.escalatedAt,
    });
  }
  return out;
}

/** Every open PR waiting on Steve after an Evaluator escalation, oldest first. */
export function listAwaitingEscalation(db: Database.Database): AwaitingEscalationItem[] {
  if (!tableExists(db, 'evaluator_runs')) return [];
  const snapshot = readOpenPrsSnapshot(db);
  const robot = robotEscalations(db, snapshot);
  // A Robot in-review ticket's PR is judged by the Robot rule, never twice.
  const robotPrs = new Set(robot.map((i) => i.prNumber));
  for (const t of db
    .prepare(
      `SELECT e.detail FROM agent_tickets t JOIN agent_ticket_events e ON e.ticket_id = t.id
        WHERE t.archived_at IS NULL AND t.assignee = 'robot' AND t.agent_state = 'in-review' AND e.type = ?`,
    )
    .all(ROBOT_EVENT.handoff) as { detail: string | null }[]) {
    try {
      const n = prFromUrl((JSON.parse(t.detail ?? '{}') as { prUrl?: string }).prUrl);
      if (n !== null) robotPrs.add(n);
    } catch {
      // unreadable detail: nothing to exclude
    }
  }
  const session = snapshot ? sessionEscalations(db, snapshot, robotPrs) : [];
  return [...robot, ...session].sort((a, b) => a.escalatedAt - b.escalatedAt);
}
