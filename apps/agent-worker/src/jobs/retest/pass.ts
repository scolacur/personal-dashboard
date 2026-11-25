import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import type { AgentWorkerConfig } from '../../shared/config';
import { logger } from '../../shared/logger';
import { notifyLoop } from '../robot/notify';
import { readStateNumber, writeState } from '../robot/state';

const run = promisify(execFile);

/**
 * Re-test PRs that failed on a broken main, once main goes green (PD-942).
 *
 * When main is red, every PR built in that window fails `verify` for main's reasons, and fixing
 * main does not clear them. A plain "Re-run" does not help: CI runs on `pull_request`, and a re-run
 * reuses the original merge commit, which was built against the broken main. The PR needs a NEW
 * `pull_request` event, which builds a fresh merge ref against current main.
 *
 * HOW (decided by Steve, 2026-11-24): convert the PR to draft and straight back. Marking it ready
 * fires `ready_for_review`, which `ci.yml` listens for. The toggle uses the bot PAT
 * (`ROBOT_GITHUB_TOKEN`), because events caused by `GITHUB_TOKEN` never start workflows.
 * Rejected:
 *  - close/reopen: a CLOSED Robot PR is "abandoned" to the worker. pr-state.ts parks the ticket
 *    needs-human, supersede.ts stops a running rework, rework-guard.ts skips a queued one.
 *  - `gh pr update-branch`: pushes onto branches that live sessions or the Robot may be using.
 *  - an Actions secret + `workflow_run` workflow: another secret, and no coordination with this worker.
 *
 * RULES (from the ticket):
 *  - Nothing is retried while main's latest completed `ci` run is failing.
 *  - A PR qualifies when its latest `verify` failed and STARTED inside a red window of main: from
 *    the first failed main run of a streak until the success that ended it. A PR that failed after
 *    main went green failed for its own reasons. Every red window in the fetched history counts,
 *    so a short green that this poll missed still gets its PRs retried.
 *  - At most once per PR head SHA. A PR that fails again on fresh main stays red.
 *  - Drafts, forks and PRs not into main are left alone; the toggle would change a draft's intent.
 */

export interface MainCiRun {
  status: string;
  conclusion: string;
  createdAt: string;
  updatedAt: string;
}

export interface RollupEntry {
  __typename?: string;
  name?: string;
  status?: string;
  conclusion?: string;
  startedAt?: string;
}

export interface RetestPr {
  number: number;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  isCrossRepository: boolean;
  isDraft: boolean;
  url: string;
  statusCheckRollup: RollupEntry[] | null;
}

export type ToggleOutcome = { kind: 'retested' } | { kind: 'error'; reason: string } | { kind: 'stuck-draft'; reason: string };

export interface RetestPassDeps {
  listMainRuns?: (repo: string) => Promise<MainCiRun[] | null>;
  listOpenPrs?: (repo: string) => Promise<RetestPr[] | null>;
  toggle?: (repo: string, prNumber: number) => Promise<ToggleOutcome>;
}

/** A red window of main: [start, end) in epoch ms. */
export interface RedWindow {
  start: number;
  end: number;
}

const LAST_KEY = 'retest_last';
/** A toggle that failed before changing anything is tried again on the same head this many times. */
const MAX_ERRORS_PER_HEAD = 3;

export function ensureRetestAttemptsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS retest_attempts (
      id          INTEGER PRIMARY KEY,
      pr_number   INTEGER NOT NULL,
      head_sha    TEXT    NOT NULL,
      outcome     TEXT    NOT NULL,
      detail      TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_retest_attempts_pr ON retest_attempts (pr_number, head_sha);
  `);
}

/** Whether this PR head is done: retested (or stuck), or out of error retries. */
export function headSettled(db: Database.Database, prNumber: number, headSha: string): boolean {
  const rows = db
    .prepare('SELECT outcome FROM retest_attempts WHERE pr_number = ? AND head_sha = ?')
    .all(prNumber, headSha) as { outcome: string }[];
  if (rows.some((r) => r.outcome !== 'error')) return true;
  return rows.length >= MAX_ERRORS_PER_HEAD;
}

function record(db: Database.Database, pr: number, head: string, outcome: string, detail: string, now: number): void {
  db.prepare('INSERT INTO retest_attempts (pr_number, head_sha, outcome, detail, created_at) VALUES (?, ?, ?, ?, ?)').run(
    pr,
    head,
    outcome,
    detail.slice(0, 4000),
    now,
  );
}

const time = (iso: string | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : NaN;
};

/**
 * main's red windows, or null when main is not green right now. Only completed runs that
 * succeeded or failed count: a cancelled run (superseded by a newer push) says nothing.
 */
export function redWindows(runs: readonly MainCiRun[]): RedWindow[] | null {
  const settled = runs
    .filter((r) => r.status === 'completed' && (r.conclusion === 'success' || r.conclusion === 'failure'))
    .filter((r) => Number.isFinite(time(r.createdAt)))
    .sort((a, b) => time(a.createdAt) - time(b.createdAt)); // oldest first
  if (settled.length === 0 || settled[settled.length - 1].conclusion !== 'success') return null;

  const windows: RedWindow[] = [];
  let redStart: number | null = null;
  for (const r of settled) {
    if (r.conclusion === 'failure') {
      if (redStart === null) redStart = time(r.createdAt);
    } else if (redStart !== null) {
      // The success that ended the streak: main is green once this run COMPLETED.
      windows.push({ start: redStart, end: time(r.updatedAt) || time(r.createdAt) });
      redStart = null;
    }
  }
  return windows;
}

/** The PR's latest `verify` check run, by start time. */
export function latestVerify(pr: RetestPr): RollupEntry | null {
  const verifies = (pr.statusCheckRollup ?? []).filter(
    (c) => c.name === 'verify' && (c.__typename === undefined || c.__typename === 'CheckRun'),
  );
  if (verifies.length === 0) return null;
  return verifies.reduce((a, b) => ((time(b.startedAt) || 0) > (time(a.startedAt) || 0) ? b : a));
}

/** Whether this PR should be re-tested now. Null when yes, else why not (for logs and tests). */
export function skipReason(db: Database.Database, pr: RetestPr, windows: readonly RedWindow[]): string | null {
  if (pr.baseRefName !== 'main') return 'not into main';
  if (pr.isCrossRepository) return 'from a fork';
  if (pr.isDraft) return 'draft';
  const verify = latestVerify(pr);
  if (!verify) return 'no verify run';
  if ((verify.status ?? '').toUpperCase() !== 'COMPLETED' || (verify.conclusion ?? '').toUpperCase() !== 'FAILURE') {
    return 'latest verify did not fail';
  }
  const started = time(verify.startedAt);
  if (!Number.isFinite(started) || !windows.some((w) => started >= w.start && started < w.end)) {
    return 'failed outside a red window of main';
  }
  if (headSettled(db, pr.number, pr.headRefOid)) return 'already retried at this head';
  return null;
}

function ghEnv(config: AgentWorkerConfig, token: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {}),
    ...(config.httpsProxy ? { HTTPS_PROXY: config.httpsProxy, HTTP_PROXY: config.httpsProxy } : {}),
  };
}

export function defaultMainRunLister(config: AgentWorkerConfig): (repo: string) => Promise<MainCiRun[] | null> {
  return async (repo) => {
    try {
      const { stdout } = await run(
        'gh',
        ['run', 'list', '--repo', repo, '--workflow', 'ci.yml', '--branch', 'main', '--event', 'push', '--limit', '30', '--json', 'status,conclusion,createdAt,updatedAt'],
        { env: ghEnv(config, config.githubReadToken) },
      );
      return JSON.parse(stdout) as MainCiRun[];
    } catch (err) {
      logger.warn({ err }, 'retest: listing main ci runs failed (skipping this pass)');
      return null;
    }
  };
}

export function defaultOpenPrLister(config: AgentWorkerConfig): (repo: string) => Promise<RetestPr[] | null> {
  return async (repo) => {
    try {
      const { stdout } = await run(
        'gh',
        [
          'pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json',
          'number,headRefName,headRefOid,baseRefName,isCrossRepository,isDraft,url,statusCheckRollup',
        ],
        { env: ghEnv(config, config.githubReadToken), maxBuffer: 16 * 1024 * 1024 },
      );
      return JSON.parse(stdout) as RetestPr[];
    } catch (err) {
      logger.warn({ err }, 'retest: listing open PRs failed (skipping this pass)');
      return null;
    }
  };
}

/** Draft, then ready again. If the second step fails the PR is left a draft: try once more, then say so. */
export function defaultToggle(config: AgentWorkerConfig): (repo: string, prNumber: number) => Promise<ToggleOutcome> {
  return async (repo, prNumber) => {
    const env = ghEnv(config, config.robot.writeToken);
    try {
      await run('gh', ['pr', 'ready', String(prNumber), '--repo', repo, '--undo'], { env });
    } catch (err) {
      return { kind: 'error', reason: `convert to draft failed: ${String(err)}` };
    }
    let last = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await run('gh', ['pr', 'ready', String(prNumber), '--repo', repo], { env });
        return { kind: 'retested' };
      } catch (err) {
        last = String(err);
      }
    }
    return { kind: 'stuck-draft', reason: `mark ready failed: ${last}` };
  };
}

/** One pass. Returns the PR numbers it re-tested (empty when there was nothing to do), or null when it did not run. */
export async function runRetestPass(
  db: Database.Database,
  config: AgentWorkerConfig,
  now: number = Date.now(),
  deps: RetestPassDeps = {},
): Promise<number[] | null> {
  if (!config.retest.enabled || !config.robot.writeToken) return null;
  if (now - readStateNumber(db, LAST_KEY) < config.retest.intervalMs) return null;
  writeState(db, LAST_KEY, String(now), now);
  ensureRetestAttemptsTable(db);

  const runs = await (deps.listMainRuns ?? defaultMainRunLister(config))(config.githubRepo);
  if (!runs) return null;
  const windows = redWindows(runs);
  if (windows === null) {
    logger.debug('retest: main is not green — waiting');
    return [];
  }
  if (windows.length === 0) return [];

  const prs = await (deps.listOpenPrs ?? defaultOpenPrLister(config))(config.githubRepo);
  if (!prs) return null;

  const toggle = deps.toggle ?? defaultToggle(config);
  const retested: number[] = [];
  for (const pr of [...prs].sort((a, b) => a.number - b.number)) {
    if (skipReason(db, pr, windows) !== null) continue;
    const outcome = await toggle(config.githubRepo, pr.number);
    switch (outcome.kind) {
      case 'retested':
        record(db, pr.number, pr.headRefOid, 'retested', 'draft → ready', now);
        retested.push(pr.number);
        logger.info({ prNumber: pr.number, head: pr.headRefOid }, 'retest: verify failed on a red main — re-testing against current main');
        break;
      case 'stuck-draft':
        record(db, pr.number, pr.headRefOid, 'stuck-draft', outcome.reason, now);
        notifyLoop(
          db,
          'agent_needs_human',
          `PR #${pr.number} was left as a draft`,
          `The worker converted it to draft to re-test it against the fixed main (PD-942), but could not mark it ready again. Mark it "Ready for review" by hand: ${outcome.reason}`.slice(0, 1000) + `\n${pr.url}`,
          now,
        );
        logger.warn({ prNumber: pr.number, reason: outcome.reason }, 'retest: PR left as a draft — notified');
        break;
      case 'error':
        record(db, pr.number, pr.headRefOid, 'error', outcome.reason, now);
        logger.warn({ prNumber: pr.number, reason: outcome.reason }, 'retest: toggle failed (nothing changed)');
        break;
    }
  }
  return retested;
}
