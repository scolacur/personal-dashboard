import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import { HUMAN_REPLY_MARKER, ROBOT_EVENT } from '@dashboard/shared';
import type { AgentWorkerConfig } from '../../shared/config';
import { logger } from '../../shared/logger';
import { logMilestone } from './events';
import { lastHandoffAt } from './runs';
import { setAgentState, completeTicket } from './board';
import { notifyAutoMerged, notifyNeedsHuman } from './notify';
import { readStateNumber, writeState } from './state';

const run = promisify(execFile);

/**
 * PR-state rework (D-055, C5/PD-346) — the Robot loop's DB-native review + conflict rework poll
 * (it replaced the retired `sortie-review-rework.yml` and `sortie-conflict-rework.yml` Actions,
 * collapsed into one poll). For each `in-review` ticket the loop
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
  /** `OPEN` | `MERGED` | `CLOSED` (gh's PR state). MERGED/CLOSED are terminal (C6/PD-347). */
  state: string;
  mergeable: string;
  reviewDecision: string | null;
  reviews: PrReview[];
  /** Top-level PR conversation (issue) comments. */
  comments: PrComment[];
  /** Inline diff-line review comments (PD-394). `gh pr view` exposes neither these nor their text
   *  via `reviews`/`comments`, so they're fetched separately — a bare inline comment posts as a
   *  COMMENTED review with an empty body and would otherwise never trigger rework. */
  inlineComments: PrComment[];
  /** Login of whoever merged the PR (PD-765); null/absent while it is unmerged or unknown. */
  mergedBy?: string | null;
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
        ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'state,mergeable,reviewDecision,reviews,comments,mergedBy'],
        { env },
      );
      const raw = JSON.parse(stdout) as {
        state?: string;
        mergeable?: string;
        reviewDecision?: string | null;
        reviews?: { author?: { login?: string }; authorAssociation?: string; state?: string; body?: string; submittedAt?: string }[];
        comments?: { author?: { login?: string }; authorAssociation?: string; body?: string; createdAt?: string }[];
        mergedBy?: { login?: string } | null;
      };
      return {
        state: raw.state ?? 'OPEN',
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
        inlineComments: await fetchInlineComments(repo, prNumber, env),
        mergedBy: raw.mergedBy?.login ?? null,
      };
    } catch (err) {
      logger.warn({ err, repo, prNumber }, 'robot: PR-state fetch failed (skipping this poll)');
      return null;
    }
  };
}

/**
 * Inline diff-line review comments (PD-394), via the REST pulls-comments endpoint — `gh pr view`
 * doesn't expose them. Best-effort and INDEPENDENT of the main fetch: its own failure resolves to
 * `[]` (a poll without inline data) rather than nulling the whole PR-state, so a hiccup here can't
 * strand an in-review ticket. Normalized to the `PrComment` shape (REST uses `user`/`author_association`/
 * `created_at`, not `gh pr view`'s camelCase).
 *
 * `direction=desc` matters and is not cosmetic: this reads ONE page, and the endpoint's default order
 * is created-ascending — so on a PR that accumulated more than `per_page` inline comments across
 * rework rounds, page 1 would hold only the OLDEST, every one of them already behind `lastHandoffAt`.
 * New feedback would be truncated away with no error, which is this ticket's original bug wearing a
 * different hat. Newest-first means the page always contains the only comments that can trigger.
 */
export function inlineCommentsPath(repo: string, prNumber: number): string {
  return `repos/${repo}/pulls/${prNumber}/comments?per_page=100&sort=created&direction=desc`;
}

async function fetchInlineComments(repo: string, prNumber: number, env: NodeJS.ProcessEnv): Promise<PrComment[]> {
  try {
    const { stdout } = await run('gh', ['api', inlineCommentsPath(repo, prNumber)], { env });
    const raw = JSON.parse(stdout) as {
      user?: { login?: string };
      author_association?: string;
      body?: string;
      created_at?: string;
    }[];
    return (raw ?? []).map((c) => ({
      authorLogin: c.user?.login ?? '',
      authorAssociation: c.author_association ?? '',
      body: c.body ?? '',
      createdAt: c.created_at ?? '',
    }));
  } catch (err) {
    logger.warn({ err, repo, prNumber }, 'robot: inline-comments fetch failed (rework may miss inline feedback this poll)');
    return [];
  }
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
 *  3. A trusted INLINE diff-line review comment (PD-394) — the most natural way to give line-level
 *     feedback, and the one `gh pr view` misses (a bare inline comment is a COMMENTED review with an
 *     empty body, so rule 1 skips it). Same trust + body + boundary rules as a top-level comment.
 *  4. `mergeable === 'CONFLICTING'` — main advanced and the branch no longer merges cleanly.
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
  for (const c of pr.inlineComments) {
    if (toMs(c.createdAt) <= lastHandoffAt) continue;
    if (c.body.trim() === '') continue;
    if (!isTrusted(c.authorAssociation, c.body)) continue;
    return { reactivate: true, reason: 'comment', detail: `inline comment from ${c.authorLogin}` };
  }
  if (pr.mergeable === 'CONFLICTING') return { reactivate: true, reason: 'conflict', detail: 'PR conflicts with main' };
  return { reactivate: false };
}

/**
 * Was this merged PR an AUTO-merge (PD-765)? True when the merge bridge did it (the Actions bot is
 * the merger) and no trusted human approval stands on it — i.e. it shipped on checks + review-gate
 * alone. A PR Steve approved and the bridge then merged is his merge, not an auto-merge; so is one
 * he merged by hand. Pure.
 */
export function isAutoMerge(pr: PrState): boolean {
  if (pr.state !== 'MERGED') return false;
  if (!/^(app\/)?github-actions(\[bot\])?$/.test(pr.mergedBy ?? '')) return false;
  return !pr.reviews.some((r) => r.state === 'APPROVED' && isTrusted(r.authorAssociation, r.body));
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
        WHERE t.archived_at IS NULL AND t.status = 'queue' AND t.assignee = 'robot' AND t.agent_state = 'in-review'`,
    )
    .all() as { ticket_id: number; pr_url: string | null }[];
  const targets: InReviewTarget[] = [];
  for (const row of rows) {
    const parsed = parsePrUrl(row.pr_url);
    if (parsed) targets.push({ ticketId: row.ticket_id, repo: parsed.repo, prNumber: parsed.prNumber });
  }
  return targets;
}

/** PD-918: the parked agent states whose PR can still merge — by a human finishing it, or because
 *  the run opened it and was parked anyway. Only MERGED is acted on for these. */
const PARKED_PR_STATES = ['stuck', 'checkpoint', 'needs-human'] as const;

export interface ParkedPrTarget extends InReviewTarget {
  fromState: string;
}

/**
 * PD-918: parked Robot tickets paired with the PR of their newest run that recorded one, whatever
 * that run's status. The in-review poll reads only `handed-off` runs of `in-review` tickets, so a
 * ticket parked with an open PR (PD-901: its PR #496 merged while it sat `stuck`) was invisible to
 * completion. Merge-only: this set is never re-activated, parked or commented on from here.
 */
export function parkedPrTargets(db: Database.Database): ParkedPrTarget[] {
  const rows = db
    .prepare(
      `SELECT t.id AS ticket_id, t.agent_state AS state, r.pr_url AS pr_url
         FROM agent_tickets t
         JOIN agent_runs r ON r.id = (
           SELECT id FROM agent_runs
            WHERE ticket_id = t.id AND pr_url IS NOT NULL
            ORDER BY started_at DESC, id DESC LIMIT 1
         )
        WHERE t.archived_at IS NULL AND t.status = 'queue' AND t.assignee = 'robot'
          AND t.agent_state IN (${PARKED_PR_STATES.map(() => '?').join(', ')})`,
    )
    .all(...PARKED_PR_STATES) as { ticket_id: number; state: string; pr_url: string | null }[];
  const targets: ParkedPrTarget[] = [];
  for (const row of rows) {
    const parsed = parsePrUrl(row.pr_url);
    if (parsed) targets.push({ ticketId: row.ticket_id, repo: parsed.repo, prNumber: parsed.prNumber, fromState: row.state });
  }
  return targets;
}

const PR_POLL_LAST = 'pr_poll_last';

/**
 * Poll in-review PRs and drive their next transition (C5/PD-346, C6/PD-347):
 *  - MERGED → complete the ticket (Completed lane);
 *  - CLOSED unmerged → park needs-human;
 *  - OPEN with trusted feedback or a conflict → re-activate for rework.
 * Throttled to `config.robot.prPollIntervalMs` via a `robot_state` timestamp — the dispatch loop
 * ticks every ~15s, but hitting the GitHub API that often per open PR is needless, so the poll runs
 * on its own slower cadence while still living inside the one loop. Returns the count re-activated
 * for rework (terminal transitions are side effects, not counted).
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

    // Terminal transitions first (C6/PD-347) — the DB-native replacement for github-sync's old
    // closed-issue→completed derivation. A MERGED PR completes the ticket; a PR closed WITHOUT
    // merging is a human abandoning it, so park needs-human rather than complete or re-dispatch.
    // Only an OPEN PR is a rework candidate.
    if (pr.state === 'MERGED') {
      completeTicket(db, target.ticketId, now);
      logMilestone(db, target.ticketId, ROBOT_EVENT.completed, { prNumber: target.prNumber }, now);
      logger.info({ ticketId: target.ticketId, prNumber: target.prNumber }, 'robot: PR merged — ticket completed');
      // Exactly once: completing the ticket takes it out of in-review, so this branch never re-runs.
      if (isAutoMerge(pr)) {
        notifyAutoMerged(db, target.ticketId, target.prNumber, `https://github.com/${target.repo}/pull/${target.prNumber}`, now);
      }
      continue;
    }
    if (pr.state === 'CLOSED') {
      setAgentState(db, target.ticketId, 'needs-human', now);
      logMilestone(db, target.ticketId, ROBOT_EVENT.prClosed, { prNumber: target.prNumber }, now);
      notifyNeedsHuman(db, target.ticketId, 'Robot PR closed unmerged', `PR #${target.prNumber} was closed without merging — needs a human.`, now);
      logger.warn({ ticketId: target.ticketId, prNumber: target.prNumber }, 'robot: PR closed unmerged — parked needs-human');
      continue;
    }

    const decision = decideReactivation(pr, lastHandoffAt(db, target.ticketId));
    if (!decision.reactivate) continue;
    // PD-774 (D-099): with the conflict resolver on, a conflict is its to route. It resolves the
    // mechanical shapes with no Robot run and re-queues the ticket itself when it cannot.
    if (decision.reason === 'conflict' && config.conflictResolver.enabled) continue;
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

  // PD-918: a parked ticket whose PR merged anyway is done. Merge-only, same throttle as above.
  // Read after the in-review loop, so a ticket that loop just moved is not seen twice.
  for (const target of parkedPrTargets(db)) {
    const pr = await fetcher(target.repo, target.prNumber);
    if (pr?.state !== 'MERGED') continue;
    completeTicket(db, target.ticketId, now);
    logMilestone(
      db,
      target.ticketId,
      ROBOT_EVENT.completed,
      { prNumber: target.prNumber, via: 'parked_pr_merged', fromState: target.fromState },
      now,
    );
    logger.info(
      { ticketId: target.ticketId, prNumber: target.prNumber, fromState: target.fromState },
      'robot: a parked ticket’s PR merged — ticket completed',
    );
  }
  return reactivated;
}
