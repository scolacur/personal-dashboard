import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { EvaluatorLens, EvaluatorReport } from '@dashboard/shared';
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

/**
 * Which lens could not produce a verdict, and whether its one error retry is still pending or has
 * been used (PD-883). Passed when the combined outcome is a no-verdict failure so the gate names the
 * culprit rather than a generic "could not produce a verdict".
 */
export interface GateFailureContext {
  lens: EvaluatorLens;
  /** The lens has used its one retry (errored twice) — this is terminal, not a transient miss. */
  retryUsed: boolean;
}

/** Pure: the status for an evaluation outcome. `report` null = no usable verdict. */
export function gateForOutcome(
  report: EvaluatorReport | null,
  round: number,
  maxRounds: number,
  failure?: GateFailureContext,
): GateStatus {
  if (!report) {
    if (failure) {
      const retry = failure.retryUsed ? 'retry used' : 'retry pending';
      return { state: 'failure', description: clip(`Needs Steve: ${failure.lens} review produced no verdict (${retry})`) };
    }
    return { state: 'failure', description: clip('Needs Steve: the Evaluator could not produce a verdict') };
  }
  if (report.verdict === 'ship') return { state: 'success', description: clip(`Evaluator: ship (round ${round})`) };
  if (report.verdict === 'escalate') return { state: 'failure', description: clip(`Needs Steve: the Evaluator escalated (round ${round})`) };
  if (round >= maxRounds) {
    return { state: 'failure', description: clip(`Needs Steve: changes still requested at the round cap (${round}/${maxRounds})`) };
  }
  return { state: 'pending', description: clip(`Evaluator requested changes (round ${round}); rework queued`) };
}

const REVIEWING_PREFIX = 'Evaluator reviewing';

/** The status while an evaluation is running. */
export function gateReviewing(round: number): GateStatus {
  return { state: 'pending', description: clip(`${REVIEWING_PREFIX} (round ${round})`) };
}

/**
 * Whether `current` is the "reviewing" pending {@link gateReviewing} posts at the start of a review.
 * Once every lens has settled, that status is stale: the final post was lost (PD-1005, Reconcile a
 * lost review-gate post), and the gate reconciliation replaces it.
 */
export function isReviewingStatus(current: GateStatus | null): boolean {
  return current?.state === 'pending' && current.description.startsWith(REVIEWING_PREFIX);
}

export type HeadShaFetcher = (repo: string, prNumber: number) => Promise<string | null>;
export type StatusPoster = (repo: string, sha: string, status: GateStatus, targetUrl: string | null) => Promise<boolean>;

/**
 * The description `review-gate.yml` posts when Steve's approval opens the gate. The Evaluator must
 * never replace that success with pending or failure (D-101 point 5), so it reads the current status
 * before posting anything but success (PD-914). Keep in step with the workflow's `DESC`.
 */
export const STEVE_APPROVED_DESCRIPTION = 'Approved by Steve';

/**
 * The newest `review-gate` status on a commit: `{ ok: true, current }` (`current` null when there is
 * none yet), or `{ ok: false }` when the read failed. A failed read must not be mistaken for "no
 * status", because posting over an unseen approval is exactly what the read exists to prevent.
 */
export type StatusRead = { ok: true; current: GateStatus | null } | { ok: false };
export type StatusReader = (repo: string, sha: string) => Promise<StatusRead>;

/** The head commit's newest `review-gate` status via the READ-ONLY token. Never throws. */
export function defaultStatusReader(config: AgentWorkerConfig): StatusReader {
  return async (repo, sha) => {
    try {
      const { stdout } = await run(
        'gh',
        [
          'api',
          `repos/${repo}/commits/${sha}/statuses`,
          '--jq',
          `[.[] | select(.context == "${REVIEW_GATE_CONTEXT}")][0] // null | if . == null then null else {state, description} end`,
        ],
        { env: ghEnv(config, config.githubReadToken) },
      );
      const parsed = JSON.parse(stdout.trim() || 'null') as { state: string; description: string | null } | null;
      if (!parsed) return { ok: true, current: null };
      return { ok: true, current: { state: parsed.state as GateState, description: parsed.description ?? '' } };
    } catch (err) {
      logger.warn({ err, repo, sha }, 'review-gate: status read failed');
      return { ok: false };
    }
  };
}

/** Whether `current` is the success Steve's approval posted, which the Evaluator must leave alone. */
export function isSteveApproval(current: GateStatus | null): boolean {
  return current?.state === 'success' && current.description.startsWith(STEVE_APPROVED_DESCRIPTION);
}

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
