import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import { ROBOT_EVENT } from '@dashboard/shared';
import type { AgentWorkerConfig } from '../../shared/config';
import { logger } from '../../shared/logger';
import { completeTicket } from '../robot/board';
import { logMilestone } from '../robot/events';
import { readStateNumber, writeState } from '../robot/state';
import { branchDisplayId } from './adoption';

const run = promisify(execFile);

/**
 * Complete a session PR's branch ticket when the PR merges (PD-915).
 *
 * The Robot path already completes the tickets it handed off (`pr-state.ts`). A PR built in a session
 * merged without anyone completing its ticket unless a human remembered to PATCH it. This pass closes
 * that gap for the **branch ticket only** (`pd-915-…`): a PR's title and body often cite related
 * tickets it does not finish, so they never count.
 *
 * Safe to re-run, and never touches a terminal ticket (D-083). Two markers in `robot_state` make it
 * act once per PR, so a ticket Steve deliberately reopens after its PR merged stays open:
 *  - **a watermark**, set on the first pass to "now". PRs merged before it are ignored, so turning
 *    this on does not sweep up every open ticket an old PR's branch happens to name;
 *  - **a per-PR key** once a merge has been acted on.
 */

export interface MergedPr {
  number: number;
  headRefName: string;
  baseRefName: string;
  mergedAt: string;
}
export type MergedPrLister = (repo: string) => Promise<MergedPr[] | null>;

const WATERMARK_KEY = 'session_merge_watermark';
const doneKey = (prNumber: number) => `session_merge_done:${prNumber}`;

export function defaultMergedPrLister(config: AgentWorkerConfig): MergedPrLister {
  return async (repo) => {
    try {
      const { stdout } = await run(
        'gh',
        ['pr', 'list', '--repo', repo, '--state', 'merged', '--limit', '30', '--json', 'number,headRefName,baseRefName,mergedAt'],
        {
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
            ...(config.githubReadToken ? { GH_TOKEN: config.githubReadToken, GITHUB_TOKEN: config.githubReadToken } : {}),
            ...(config.httpsProxy ? { HTTPS_PROXY: config.httpsProxy, HTTP_PROXY: config.httpsProxy } : {}),
          },
        },
      );
      return JSON.parse(stdout) as MergedPr[];
    } catch (err) {
      logger.warn({ err }, 'session merges: listing merged PRs failed (skipping this pass)');
      return null;
    }
  };
}

/** Returns the number of tickets completed. */
export async function completeMergedSessionTickets(
  db: Database.Database,
  config: AgentWorkerConfig,
  now: number = Date.now(),
  deps: { listMerged?: MergedPrLister } = {},
): Promise<number> {
  const watermark = readStateNumber(db, WATERMARK_KEY);
  if (watermark === 0) {
    writeState(db, WATERMARK_KEY, String(now), now);
    return 0;
  }
  const merged = await (deps.listMerged ?? defaultMergedPrLister(config))(config.githubRepo);
  if (!merged) return 0;

  let completed = 0;
  for (const pr of merged) {
    if (pr.baseRefName !== 'main' || pr.headRefName.startsWith('robot/')) continue;
    if (Date.parse(pr.mergedAt) <= watermark) continue;
    if (readStateNumber(db, doneKey(pr.number)) !== 0) continue;
    writeState(db, doneKey(pr.number), String(now), now);

    const displayId = branchDisplayId(pr.headRefName);
    if (!displayId) continue;
    const t = db
      .prepare('SELECT id, status FROM agent_tickets WHERE display_id = ? AND archived_at IS NULL')
      .get(displayId) as { id: number; status: string } | undefined;
    if (!t || t.status === 'completed' || t.status === 'closed') continue;

    completeTicket(db, t.id, now);
    logMilestone(db, t.id, ROBOT_EVENT.completed, { prNumber: pr.number, via: 'session_pr_merged' }, now);
    logger.info({ ticketId: t.id, prNumber: pr.number }, 'session merges: PR merged — branch ticket completed');
    completed++;
  }
  return completed;
}
