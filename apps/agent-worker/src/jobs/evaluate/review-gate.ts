import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { EvaluatorReport } from '@dashboard/shared';
import type { AgentWorkerConfig } from '../../shared/config';
import { logger } from '../../shared/logger';

const run = promisify(execFile);

/**
 * The `review-gate` commit status on Robot PRs (PD-763, part of the auto-merge Epic PD-762).
 *
 * Branch protection will require `review-gate` in place of an approving review. On a Robot PR it
 * reflects the Evaluator's verdict on the exact commit it reviewed: `ship` → success; a `revise`
 * that sends the PR back → pending; a `revise` at the round cap, an `escalate`, or an evaluation
 * that produced no usable verdict → failure, which means "needs Steve". A failed evaluation is
 * never a success (D-076).
 *
 * **The token is the security boundary.** `REVIEW_GATE_TOKEN` can write commit statuses and nothing
 * else, lives only in the worker process, and is stripped from the Robot's coding session
 * (`codingEnv`). If the Robot could read it, it could mark its own PR reviewed. With the token
 * unset, nothing is posted and the Evaluator behaves exactly as before.
 */

export const REVIEW_GATE_CONTEXT = 'review-gate';

export type GateState = 'success' | 'pending' | 'failure';

export interface GateStatus {
  state: GateState;
  /** GitHub caps a status description at 140 characters. */
  description: string;
}

const clip = (s: string) => (s.length <= 140 ? s : `${s.slice(0, 139)}…`);

/** Pure: the status for an evaluation outcome. `report` null = no usable verdict. */
export function gateForOutcome(report: EvaluatorReport | null, round: number, maxRounds: number): GateStatus {
  if (!report) return { state: 'failure', description: clip('Needs Steve: the Evaluator could not produce a verdict') };
  if (report.verdict === 'ship') return { state: 'success', description: clip(`Evaluator: ship (round ${round})`) };
  if (report.verdict === 'escalate') return { state: 'failure', description: clip(`Needs Steve: the Evaluator escalated (round ${round})`) };
  if (round >= maxRounds) {
    return { state: 'failure', description: clip(`Needs Steve: changes still requested at the round cap (${round}/${maxRounds})`) };
  }
  return { state: 'pending', description: clip(`Evaluator requested changes (round ${round}); rework queued`) };
}

/** The status while an evaluation is running. */
export function gateReviewing(round: number): GateStatus {
  return { state: 'pending', description: clip(`Evaluator reviewing (round ${round})`) };
}

export type HeadShaFetcher = (repo: string, prNumber: number) => Promise<string | null>;
export type StatusPoster = (repo: string, sha: string, status: GateStatus, targetUrl: string | null) => Promise<boolean>;

function ghEnv(config: AgentWorkerConfig, token: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    ...(config.httpsProxy ? { HTTPS_PROXY: config.httpsProxy, HTTP_PROXY: config.httpsProxy } : {}),
  };
}

/** The PR's current head SHA via the READ-ONLY token, or null on any failure. */
export function defaultHeadShaFetcher(config: AgentWorkerConfig): HeadShaFetcher {
  return async (repo, prNumber) => {
    try {
      const { stdout } = await run(
        'gh',
        ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'headRefOid', '--jq', '.headRefOid'],
        { env: ghEnv(config, config.githubReadToken) },
      );
      const sha = stdout.trim();
      return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
    } catch (err) {
      logger.warn({ err, repo, prNumber }, 'review-gate: head SHA fetch failed');
      return null;
    }
  };
}

/** Post the status with the statuses-only token. Resolves false on failure; never throws. */
export function defaultStatusPoster(config: AgentWorkerConfig): StatusPoster {
  return async (repo, sha, status, targetUrl) => {
    try {
      await run(
        'gh',
        [
          'api',
          '--method',
          'POST',
          `repos/${repo}/statuses/${sha}`,
          '-f',
          `state=${status.state}`,
          '-f',
          `context=${REVIEW_GATE_CONTEXT}`,
          '-f',
          `description=${status.description}`,
          ...(targetUrl ? ['-f', `target_url=${targetUrl}`] : []),
        ],
        { env: ghEnv(config, config.evaluator.reviewGateToken) },
      );
      return true;
    } catch (err) {
      logger.warn({ err, repo, sha, state: status.state }, 'review-gate: status post failed');
      return false;
    }
  };
}

/** The ticket page a status links to, when a base URL is configured. */
export function gateTargetUrl(config: AgentWorkerConfig, displayId: string | null): string | null {
  const base = config.evaluator.reviewGateTicketUrlBase;
  if (!base || !displayId) return null;
  return `${base.replace(/\/+$/, '')}/${encodeURIComponent(displayId)}`;
}
