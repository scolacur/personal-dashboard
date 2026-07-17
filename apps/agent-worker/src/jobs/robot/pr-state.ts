import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import { HUMAN_REPLY_MARKER, ROBOT_EVENT } from '@dashboard/shared';
import type { AgentWorkerConfig } from '../../shared/config';
import { logger } from '../../shared/logger';
import { logMilestone } from './events';
import { lastHandoffAt } from './runs';
import { setAgentState } from './board';
import { readStateNumber, writeState } from './state';

const run = promisify(execFile);

/**
 * PR-state rework (D-055, C5/PD-346) — the DB-native replacement for BOTH `sortie-review-rework.yml`
 * and `sortie-conflict-rework.yml`, collapsed into one poll. For each `in-review` ticket the loop
 * reads its PR's review decision, conversation comments, and merge status via the GitHub read API,
 * and re-activates the ticket in-DB (`agent_state = queued`) when a human left feedback or the PR now
 * conflicts with main. The reused branch + the resume-aware prompt (Step 0) then drive the rework.
 *
 * No webhooks (a LAN-only dashboard can't receive them) — polling PR state is the accepted trade-off
 * (D-055). No labels are read or written; the board DB is the state machine.
 */

export interface PrReview {
  authorLogin: string;
  authorAssociation: string;
  state: string;
  body: string;
  submittedAt: string;
}
export interface PrComment {
  authorLogin: string;
  authorAssociation: string;
  body: string;
  createdAt: string;
}
export interface PrState {
  mergeable: string;
  reviewDecision: string | null;
  reviews: PrReview[];
  comments: PrComment[];
}

/** Fetch a PR's state (injectable so tests never shell out). Returns null on any failure. */
export type PrFetcher = (repo: string, prNumber: number) => Promise<PrState | null>;

/**
 * Default fetcher: `gh pr view` with the READ-only token + squid proxy attached via env. Read-only
 * by design — polling PR state must never need the write token. Any error (network, missing PR,
 * bad JSON) resolves to null so a poll failure is a skipped poll, never a crashed loop.
 */
export function defaultPrFetcher(config: AgentWorkerConfig): PrFetcher {
  return async (repo, prNumber) => {
    try {
      const token = config.githubReadToken;
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        ...(token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {}),
        ...(config.httpsProxy ? { HTTPS_PROXY: config.httpsProxy, HTTP_PROXY: config.httpsProxy } : {}),
      };
      const { stdout } = await run(
        'gh',
        ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'mergeable,reviewDecision,reviews,comments'],
        { env },
      );
      const raw = JSON.parse(stdout) as {
        mergeable?: string;
        reviewDecision?: string | null;
        reviews?: { author?: { login?: string }; authorAssociation?: string; state?: string; body?: string; submittedAt?: string }[];
        comments?: { author?: { login?: string }; authorAssociation?: string; body?: string; createdAt?: string }[];
      };
      return {
        mergeable: raw.mergeable ?? 'UNKNOWN',
        reviewDecision: raw.reviewDecision ?? null,
        reviews: (raw.reviews ?? []).map((r) => ({
          authorLogin: r.author?.login ?? '',
          authorAssociation: r.authorAssociation ?? '',
          state: r.state ?? '',
          body: r.body ?? '',
          submittedAt: r.submittedAt ?? '',
        })),
        comments: (raw.comments ?? []).map((c) => ({
          authorLogin: c.author?.login ?? '',
          authorAssociation: c.authorAssociation ?? '',
          body: c.body ?? '',
          createdAt: c.createdAt ?? '',
        })),
      };
    } catch (err) {
      logger.warn({ err, repo, prNumber }, 'robot: PR-state fetch failed (skipping this poll)');
      return null;
    }
  };
}

export type ReactivationReason = 'review' | 'comment' | 'conflict';
export interface ReactivationDecision {
  reactivate: boolean;
  reason?: ReactivationReason;
  detail?: string;
}

/** Trusted feedback author: the repo OWNER directly, or a COLLABORATOR (dashboard/Discord bot)
 *  forwarding a human reply carrying the marker. Mirrors the old bridges' authorization model — the
 *  Robot's own bot comments (COLLABORATOR, no marker) and a stranger's (NONE) are excluded, so
 *  neither can trigger a rework loop. */
function isTrusted(assoc: string, body: string): boolean {
  return assoc === 'OWNER' || (assoc === 'COLLABORATOR' && body.includes(HUMAN_REPLY_MARKER));
}

function toMs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Decide whether an in-review PR should re-activate its ticket for rework. Pure.
 *  1. A trusted review that is CHANGES_REQUESTED, or COMMENTED with a body, submitted AFTER the last
 *     hand-off. A pure APPROVED review is NOT a trigger (approval = ready to merge, not re-work).
 *  2. A trusted top-level PR conversation comment (with a body) created after the last hand-off — the
 *     way feedback is often left outside a formal review (the second half of PD-256).
 *  3. `mergeable === 'CONFLICTING'` — main advanced and the branch no longer merges cleanly.
 * The `lastHandoffAt` boundary is what stops a stale CHANGES_REQUESTED review from re-triggering every
 * poll: after a rework hands off again, the boundary advances past that review's timestamp.
 */
export function decideReactivation(pr: PrState, lastHandoffAt: number): ReactivationDecision {
  for (const r of pr.reviews) {
    if (toMs(r.submittedAt) <= lastHandoffAt) continue;
    if (!isTrusted(r.authorAssociation, r.body)) continue;
    const feedback = r.state === 'CHANGES_REQUESTED' || (r.state === 'COMMENTED' && r.body.trim() !== '');
    if (feedback) return { reactivate: true, reason: 'review', detail: `${r.state} review from ${r.authorLogin}` };
  }
  for (const c of pr.comments) {
    if (toMs(c.createdAt) <= lastHandoffAt) continue;
    if (c.body.trim() === '') continue;
    if (!isTrusted(c.authorAssociation, c.body)) continue;
    return { reactivate: true, reason: 'comment', detail: `PR comment from ${c.authorLogin}` };
  }
  if (pr.mergeable === 'CONFLICTING') return { reactivate: true, reason: 'conflict', detail: 'PR conflicts with main' };
  return { reactivate: false };
}

interface InReviewTarget {
  ticketId: number;
  repo: string;
  prNumber: number;
}

/** `https://github.com/<owner>/<repo>/pull/<n>` → `{ repo: 'owner/repo', prNumber: n }`, or null. */
export function parsePrUrl(url: string | null): { repo: string; prNumber: number } | null {
  if (!url) return null;
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  if (!m) return null;
  return { repo: m[1], prNumber: Number(m[2]) };
}

/** In-review tickets paired with the PR of their newest handed-off run — the poll's targets. */
export function inReviewPrTargets(db: Database.Database): InReviewTarget[] {
  const rows = db
    .prepare(
      `SELECT t.id AS ticket_id, r.pr_url AS pr_url
         FROM agent_tickets t
         JOIN agent_runs r ON r.id = (
           SELECT id FROM agent_runs
            WHERE ticket_id = t.id AND status = 'handed-off' AND pr_url IS NOT NULL
            ORDER BY finished_at DESC, id DESC LIMIT 1
         )
        WHERE t.archived_at IS NULL AND t.status = 'robot_queue' AND t.agent_state = 'in-review'`,
    )
    .all() as { ticket_id: number; pr_url: string | null }[];
  const targets: InReviewTarget[] = [];
  for (const row of rows) {
    const parsed = parsePrUrl(row.pr_url);
    if (parsed) targets.push({ ticketId: row.ticket_id, repo: parsed.repo, prNumber: parsed.prNumber });
  }
  return targets;
}

const PR_POLL_LAST = 'pr_poll_last';

/**
 * Poll in-review PRs and re-activate any that got human feedback or now conflict (C5/PD-346).
 * Throttled to `config.robot.prPollIntervalMs` via a `robot_state` timestamp — the dispatch loop
 * ticks every ~15s, but hitting the GitHub API that often per open PR is needless, so the poll runs
 * on its own slower cadence while still living inside the one loop. Returns the count re-activated.
 */
export async function pollInReviewPrs(
  db: Database.Database,
  config: AgentWorkerConfig,
  now: number = Date.now(),
  fetcher: PrFetcher = defaultPrFetcher(config),
): Promise<number> {
  const last = readStateNumber(db, PR_POLL_LAST);
  if (now - last < config.robot.prPollIntervalMs) return 0;
  writeState(db, PR_POLL_LAST, String(now), now);

  let reactivated = 0;
  for (const target of inReviewPrTargets(db)) {
    const pr = await fetcher(target.repo, target.prNumber);
    if (!pr) continue;
    const decision = decideReactivation(pr, lastHandoffAt(db, target.ticketId));
    if (!decision.reactivate) continue;
    setAgentState(db, target.ticketId, 'queued', now);
    logMilestone(
      db,
      target.ticketId,
      ROBOT_EVENT.reactivated,
      { reason: decision.detail ?? decision.reason, prNumber: target.prNumber },
      now,
    );
    logger.info({ ticketId: target.ticketId, reason: decision.reason, prNumber: target.prNumber }, 'robot: in-review PR needs rework — re-activated');
    reactivated++;
  }
  return reactivated;
}
