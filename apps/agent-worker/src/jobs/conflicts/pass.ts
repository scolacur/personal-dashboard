import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import { ROBOT_EVENT } from '@dashboard/shared';
import type { AgentWorkerConfig } from '../../shared/config';
import { logger } from '../../shared/logger';
import { setAgentState } from '../robot/board';
import { logMilestone } from '../robot/events';
import { notifyLoop } from '../robot/notify';
import { inReviewPrTargets } from '../robot/pr-state';
import { adoptedPrNumbers } from '../evaluate/adoption';
import { readStateNumber, writeState } from '../robot/state';
import { commentResolved, resolveConflicts, type ResolveOutcome, type ResolveTarget } from './resolve';
import { effectiveConfig } from '../../shared/effective-config';

const run = promisify(execFile);

/**
 * The conflict resolver's poll (PD-774, D-099). Each pass looks at the repo's open PRs, takes ONE
 * that GitHub reports CONFLICTING and has not been tried at its current head, resolves it if the
 * shape is mechanical, and routes it if not:
 *  - a Robot PR the resolver cannot fix goes back to the Robot exactly as before (re-queued with a
 *    `conflict` reactivation); one it fixes is re-reviewed by the Evaluator (the event below is a
 *    review boundary);
 *  - any other PR (Steve's, a session's) gets a notification instead, since nobody re-runs it.
 * A Robot PR whose ticket is not `in-review` is left alone: the Robot itself is on the branch.
 *
 * One PR per pass because a resolution runs `npm ci` and the whole verify; the job never overlaps
 * itself, so a backlog of conflicts drains one per interval.
 */

export interface OpenPr {
  number: number;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  mergeable: string;
  isCrossRepository: boolean;
  url: string;
}
export type OpenPrLister = (repo: string) => Promise<OpenPr[] | null>;
export type Resolver = (target: ResolveTarget) => Promise<ResolveOutcome>;
export type Commenter = (target: ResolveTarget, outcome: Extract<ResolveOutcome, { kind: 'resolved' }>) => Promise<void>;

export interface ConflictPassDeps {
  listOpenPrs?: OpenPrLister;
  resolve?: Resolver;
  comment?: Commenter;
}

const LAST_KEY = 'conflict_resolver_last';
/** Transient failures (clone, network) are retried on the same head this many times, then left. */
const MAX_ERRORS_PER_HEAD = 3;

export function ensureConflictAttemptsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conflict_attempts (
      id          INTEGER PRIMARY KEY,
      pr_number   INTEGER NOT NULL,
      head_sha    TEXT    NOT NULL,
      outcome     TEXT    NOT NULL,
      detail      TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conflict_attempts_pr ON conflict_attempts (pr_number, head_sha);
  `);
}

/** Whether this PR head is settled: tried to a final outcome, or out of retries. */
export function headSettled(db: Database.Database, prNumber: number, headSha: string): boolean {
  const rows = db
    .prepare('SELECT outcome FROM conflict_attempts WHERE pr_number = ? AND head_sha = ?')
    .all(prNumber, headSha) as { outcome: string }[];
  if (rows.some((r) => r.outcome !== 'error')) return true;
  return rows.length >= MAX_ERRORS_PER_HEAD;
}

function record(db: Database.Database, pr: number, head: string, outcome: string, detail: string, now: number): void {
  db.prepare('INSERT INTO conflict_attempts (pr_number, head_sha, outcome, detail, created_at) VALUES (?, ?, ?, ?, ?)').run(
    pr,
    head,
    outcome,
    detail.slice(0, 4000),
    now,
  );
}

export function defaultOpenPrLister(config: AgentWorkerConfig): OpenPrLister {
  return async (repo) => {
    try {
      const token = config.githubReadToken;
      const { stdout } = await run(
        'gh',
        ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', 'number,headRefName,headRefOid,baseRefName,mergeable,isCrossRepository,url'],
        {
          env: {
            ...process.env,
            ...(token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {}),
            ...(config.httpsProxy ? { HTTPS_PROXY: config.httpsProxy, HTTP_PROXY: config.httpsProxy } : {}),
          },
        },
      );
      return JSON.parse(stdout) as OpenPr[];
    } catch (err) {
      logger.warn({ err }, 'conflicts: listing open PRs failed (skipping this pass)');
      return null;
    }
  };
}

/** The next PR worth trying, with its Robot ticket when it has one; null when there is none. */
export function nextConflictedPr(
  db: Database.Database,
  prs: readonly OpenPr[],
): { pr: OpenPr; ticketId: number | null } | null {
  const robotTickets = new Map(inReviewPrTargets(db).map((t) => [t.prNumber, t.ticketId]));
  // PD-913: an adopted session PR the Robot is about to rework or is reworking is its branch until
  // hand-off, the same as a `robot/*` PR that has left review.
  const adopted = adoptedPrNumbers(db);
  for (const pr of [...prs].sort((a, b) => a.number - b.number)) {
    if (pr.mergeable !== 'CONFLICTING' || pr.baseRefName !== 'main' || pr.isCrossRepository) continue;
    if (headSettled(db, pr.number, pr.headRefOid)) continue;
    if (adopted.has(pr.number)) continue;
    const isRobot = pr.headRefName.startsWith('robot/');
    const ticketId = robotTickets.get(pr.number) ?? null;
    if (isRobot && ticketId === null) continue; // the Robot is on it (or it left review)
    return { pr, ticketId };
  }
  return null;
}

export async function runConflictPass(
  db: Database.Database,
  baseConfig: AgentWorkerConfig,
  now: number = Date.now(),
  deps: ConflictPassDeps = {},
): Promise<ResolveOutcome['kind'] | null> {
  const config = effectiveConfig(db, baseConfig); // PD-1006 (D-121): live interval override
  if (!config.conflictResolver.enabled) return null;
  if (now - readStateNumber(db, LAST_KEY) < config.conflictResolver.intervalMs) return null;
  writeState(db, LAST_KEY, String(now), now);
  ensureConflictAttemptsTable(db);

  const prs = await (deps.listOpenPrs ?? defaultOpenPrLister(config))(config.githubRepo);
  if (!prs) return null;
  const next = nextConflictedPr(db, prs);
  if (!next) return null;
  const { pr, ticketId } = next;

  const target: ResolveTarget = { repo: config.githubRepo, prNumber: pr.number, branch: pr.headRefName, headSha: pr.headRefOid };
  logger.info({ prNumber: pr.number, branch: pr.headRefName }, 'conflicts: trying to resolve');
  const outcome = await (deps.resolve ?? ((t) => resolveConflicts(config, t)))(target);

  switch (outcome.kind) {
    case 'resolved': {
      record(db, pr.number, pr.headRefOid, 'resolved', outcome.files.map((f) => f.path).join(', '), now);
      try {
        await (deps.comment ?? ((t, o) => commentResolved(config, t, o)))(target, outcome);
      } catch (err) {
        logger.warn({ err, prNumber: pr.number }, 'conflicts: PR comment failed (the push stands)');
      }
      if (ticketId !== null) {
        logMilestone(db, ticketId, ROBOT_EVENT.conflictResolved, { prNumber: pr.number, files: outcome.files.map((f) => f.path) }, now);
      }
      logger.info({ prNumber: pr.number, sha: outcome.mergeSha }, 'conflicts: resolved and pushed');
      break;
    }
    case 'refused':
    case 'verify-failed': {
      record(db, pr.number, pr.headRefOid, outcome.kind, outcome.reason, now);
      const why = outcome.kind === 'refused' ? outcome.reason : `the merge did not pass verify: ${outcome.reason}`;
      if (ticketId !== null) {
        // Today's path: the Robot reworks its own conflicting PR on the reused branch.
        setAgentState(db, ticketId, 'queued', now);
        logMilestone(db, ticketId, ROBOT_EVENT.reactivated, { reason: `PR conflicts with main, not mechanically: ${why}`.slice(0, 500), prNumber: pr.number }, now);
      } else {
        notifyLoop(db, 'agent_needs_human', `PR #${pr.number} conflicts with main`, `Not a mechanical conflict, so it needs a hand merge: ${why}`.slice(0, 1000) + `\n${pr.url}`, now);
      }
      logger.info({ prNumber: pr.number, outcome: outcome.kind }, 'conflicts: not resolved, routed');
      break;
    }
    case 'raced':
      // The head moved; the next pass sees the new head. Nothing to record against the old one.
      logger.info({ prNumber: pr.number, reason: outcome.reason }, 'conflicts: branch moved, retrying later');
      break;
    case 'error':
      record(db, pr.number, pr.headRefOid, 'error', outcome.reason, now);
      logger.warn({ prNumber: pr.number, reason: outcome.reason }, 'conflicts: resolver error');
      break;
  }
  return outcome.kind;
}
