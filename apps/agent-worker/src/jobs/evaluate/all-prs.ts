import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import {
  buildEvaluatorPrompt,
  evaluatorSystemPrompt,
  HUMAN_REPLY_MARKER,
  ROBOT_EVENT,
  securityEvaluatorSystemPrompt,
  type EvaluatorLens,
  type EvaluatorReport,
} from '@dashboard/shared';
import type { AgentWorkerConfig } from '../../shared/config';
import { buildContextPack } from '../../shared/context-pack';
import { logger } from '../../shared/logger';
import { logMilestone } from '../robot/events';
import { notifyLoop } from '../robot/notify';
import { runEvaluatorTurn } from './evaluate-agent';
import { capDiff, combineReports, defaultDiffFetcher, type EvaluatePassDeps } from './evaluate';
import { finishEvaluatorRun, headEvaluated, NO_TICKET, prRounds, startEvaluatorRun } from './evaluator-runs';
import { defaultHeadShaFetcher, defaultStatusPoster, gateTargetUrl } from './review-gate';
import { blockingFindings, MAX_EVALUATION_ROUNDS, parseEvaluatorReport } from './verdict';

const run = promisify(execFile);

/**
 * The Evaluator on every PR, not just Robot hand-offs (PD-712, D-101).
 *
 * Robot PRs keep their own path (`evaluateOnePr`): found in the DB, rework through `ResumeContext`.
 * Everything else (Steve's PRs, the PRs a session opens) is found here from the GitHub read API and
 * reviewed per head commit, so a new push is a new review, up to the round cap.
 *
 * What a review produces:
 *  - **a PR comment** from the bot account with the verdict and findings. The PR-state poll never
 *    trusts the bot (a COLLABORATOR without `HUMAN_REPLY_MARKER`), and the marker is stripped from
 *    anything quoted, so a review can never trigger Robot rework;
 *  - **a timeline event** on the linked ticket, when there is one;
 *  - **`review-gate` success on a ship from every lens**, the same as Steve's approval (Steve's call,
 *    2026-11-20). Nothing else is posted: a revise or a failed review leaves the gate to Steve's
 *    approval, so the Evaluator can open the gate early but never close one he opened.
 */

export interface OtherPr {
  number: number;
  title: string;
  body: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  isCrossRepository: boolean;
  isDraft: boolean;
  labels: { name: string }[];
  files: { path: string }[];
}

export type OtherPrLister = (repo: string) => Promise<OtherPr[] | null>;
export type PrCommenter = (repo: string, prNumber: number, body: string) => Promise<void>;

export interface AllPrsDeps extends EvaluatePassDeps {
  listPrs?: OtherPrLister;
  comment?: PrCommenter;
}

export const SKIP_LABEL = 'skip-evaluator';

/** Why a PR is not reviewed by this path, or null when it should be. */
export function skipReason(pr: OtherPr): string | null {
  if (pr.headRefName.startsWith('robot/')) return 'robot PR (its own path)';
  if (pr.baseRefName !== 'main') return 'not into main';
  if (pr.isCrossRepository) return 'from a fork';
  if (pr.isDraft) return 'draft';
  if (pr.labels.some((l) => l.name === SKIP_LABEL)) return `labelled ${SKIP_LABEL}`;
  if (pr.files.length > 0 && pr.files.every((f) => f.path.startsWith('MEMORY/'))) return 'MEMORY-only';
  return null;
}

/** The ticket a PR is about: a display id in its branch (`pd-705-x`), title, or body, that exists. */
export function linkedTicket(
  db: Database.Database,
  pr: Pick<OtherPr, 'headRefName' | 'title' | 'body'>,
): { id: number; displayId: string; title: string; body: string | null } | null {
  const candidates: string[] = [];
  const branch = /^([a-z]{1,4})-(\d+)(?:-|$)/i.exec(pr.headRefName);
  if (branch) candidates.push(`${branch[1]}-${branch[2]}`.toUpperCase());
  for (const text of [pr.title, pr.body]) {
    for (const m of (text ?? '').matchAll(/\b([A-Z]{1,4})-(\d+)\b/g)) candidates.push(`${m[1]}-${m[2]}`);
  }
  for (const displayId of candidates) {
    if (/^D-\d+$/.test(displayId)) continue; // a decision, not a ticket
    const row = db
      .prepare('SELECT id, display_id, title, body FROM agent_tickets WHERE display_id = ? AND archived_at IS NULL')
      .get(displayId) as { id: number; display_id: string; title: string; body: string | null } | undefined;
    if (row) return { id: row.id, displayId: row.display_id, title: row.title, body: row.body };
  }
  return null;
}

function ghEnv(config: AgentWorkerConfig, token: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    ...(token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {}),
    ...(config.httpsProxy ? { HTTPS_PROXY: config.httpsProxy, HTTP_PROXY: config.httpsProxy } : {}),
  };
}

export function defaultOtherPrLister(config: AgentWorkerConfig): OtherPrLister {
  return async (repo) => {
    try {
      const { stdout } = await run(
        'gh',
        [
          'pr', 'list', '--repo', repo, '--state', 'open', '--limit', '50', '--json',
          'number,title,body,headRefName,headRefOid,baseRefName,isCrossRepository,isDraft,labels,files',
        ],
        { env: ghEnv(config, config.githubReadToken), maxBuffer: 16 * 1024 * 1024 },
      );
      return JSON.parse(stdout) as OtherPr[];
    } catch (err) {
      logger.warn({ err }, 'evaluator: listing open PRs failed (skipping non-Robot PRs this pass)');
      return null;
    }
  };
}

/** Comment with the bot's write token. Best effort: a failed comment never changes the verdict. */
export function defaultPrCommenter(config: AgentWorkerConfig): PrCommenter {
  return async (repo, prNumber, body) => {
    if (!config.robot.writeToken) return;
    try {
      await run('gh', ['pr', 'comment', String(prNumber), '--repo', repo, '--body', body], {
        env: ghEnv(config, config.robot.writeToken),
      });
    } catch (err) {
      logger.warn({ err, prNumber }, 'evaluator: PR comment failed (the verdict is still recorded)');
    }
  };
}

/** The PR comment. Never carries HUMAN_REPLY_MARKER, whatever the agent quoted (see the header). */
export function verdictComment(
  report: EvaluatorReport | null,
  round: number,
  ticket: { displayId: string; title: string } | null,
): string {
  const lines: string[] = ['<!-- evaluator:verdict -->'];
  const against = ticket ? `${ticket.displayId} (${ticket.title})` : 'the PR description (no linked ticket, so no acceptance criteria)';
  if (!report) {
    lines.push(`**Evaluator (round ${round}): no usable verdict.** The review failed, so it counts as neither ship nor revise. Steve's approval decides.`);
  } else {
    const blocking = blockingFindings(report);
    lines.push(`**Evaluator (round ${round}): ${report.verdict}**, judged against ${against}.`, '', report.summary);
    if (report.findings.length > 0) {
      lines.push('', '| | Where | Finding |', '|---|---|---|');
      for (const f of report.findings) {
        const mark = blocking.includes(f) ? 'blocking' : 'advisory';
        const cell = (t: string) => t.replace(/\n/g, ' ').replace(/\|/g, '\\|');
        lines.push(`| ${mark} | ${cell(f.where || '')} | ${cell(f.what || '')} |`);
      }
    }
    lines.push(
      '',
      report.verdict === 'ship'
        ? 'review-gate is set to success for this commit.'
        : `review-gate is left to Steve's approval. A new push is reviewed again (up to ${MAX_EVALUATION_ROUNDS} rounds).`,
    );
  }
  return lines.join('\n').split(HUMAN_REPLY_MARKER).join('');
}

/**
 * Review the next non-Robot PR that needs it: one per pass, since each costs a full agent turn per
 * lens. Returns the combined verdict, or undefined when nothing needed review.
 */
export async function evaluateNextOtherPr(
  db: Database.Database,
  config: AgentWorkerConfig,
  now: number = Date.now(),
  deps: AllPrsDeps = {},
): Promise<EvaluatorReport | null | undefined> {
  const prs = await (deps.listPrs ?? defaultOtherPrLister(config))(config.githubRepo);
  if (!prs) return undefined;
  const pr = [...prs]
    .sort((a, b) => a.number - b.number)
    .find((p) => skipReason(p) === null && !headEvaluated(db, p.number, p.headRefOid) && prRounds(db, p.number) < MAX_EVALUATION_ROUNDS);
  if (!pr) return undefined;

  const lenses: EvaluatorLens[] = config.evaluator.securityEnabled ? ['code', 'security'] : ['code'];
  const round = prRounds(db, pr.number) + 1;
  const ticket = linkedTicket(db, pr);
  const ticketId = ticket?.id ?? NO_TICKET;
  const repo = config.githubRepo;

  const runIds = new Map<EvaluatorLens, number>();
  for (const lens of lenses) {
    runIds.set(lens, startEvaluatorRun(db, { ticketId, prNumber: pr.number, round, model: config.evaluator.model, lens, headSha: pr.headRefOid }, now));
    if (ticket) logMilestone(db, ticket.id, ROBOT_EVENT.evaluating, { round, prNumber: pr.number, lens }, now);
  }

  // The verdict must belong to the commit that was read. A push between the listing and the diff
  // makes this review stale: drop it, and the next pass reviews the new head.
  const head = await (deps.fetchHeadSha ?? defaultHeadShaFetcher(config))(repo, pr.number);
  const rawDiff = head === pr.headRefOid ? await (deps.fetchDiff ?? defaultDiffFetcher(config))(repo, pr.number) : null;
  if (rawDiff === null) {
    for (const id of runIds.values()) finishEvaluatorRun(db, id, { error: head === pr.headRefOid ? 'diff fetch failed' : 'head moved before review' }, now);
    return null;
  }
  const { diff, truncated } = capDiff(rawDiff);
  const userPrompt = buildEvaluatorPrompt({
    title: ticket ? ticket.title : pr.title,
    body: ticket
      ? ticket.body
      : [
          'NO LINKED TICKET: there are no acceptance criteria. Judge correctness, quality, standards and',
          'scope against this PR description, and say in your summary that it was judged without a ticket.',
          '',
          pr.body || '(empty description)',
        ].join('\n'),
    prNumber: pr.number,
    diff,
    diffTruncated: truncated,
  });
  const contextPack = (deps.buildContext ?? buildContextPack)(config.checkoutDir);

  const reports: (EvaluatorReport | null)[] = [];
  for (const lens of lenses) {
    const runId = runIds.get(lens)!;
    const system = lens === 'security' ? securityEvaluatorSystemPrompt(contextPack) : evaluatorSystemPrompt(contextPack);
    const result = await (deps.runAgent ?? runEvaluatorTurn)(config, system, userPrompt);
    const report = result.ok ? parseEvaluatorReport(result.text) : null;
    finishEvaluatorRun(
      db,
      runId,
      report
        ? { report, turns: result.turns, tokens: result.tokens }
        : { error: result.ok ? `unparseable report: ${result.text.slice(0, 500)}` : result.text || 'agent error', turns: result.turns, tokens: result.tokens },
      now,
    );
    if (report && ticket) {
      logMilestone(db, ticket.id, ROBOT_EVENT.evaluated, {
        verdict: report.verdict,
        findings: report.findings.length,
        blockingFindings: blockingFindings(report).length,
        round,
        prNumber: pr.number,
        reason: report.summary,
        lens,
      }, now);
    }
    if (report && lens === 'security' && report.findings.some((f) => f.kind === 'secret')) {
      notifyLoop(db, 'agent_needs_human', `Possible secret in PR #${pr.number}: rotate it`, 'The security reviewer found a credential in a PR. The repo is public, so treat it as leaked: rotate it now, then remove it from the branch.', now);
    }
    reports.push(report);
  }

  const combined = combineReports(reports);
  await (deps.comment ?? defaultPrCommenter(config))(repo, pr.number, verdictComment(combined, round, ticket));
  if (combined?.verdict === 'ship' && config.evaluator.reviewGateToken) {
    await (deps.postStatus ?? defaultStatusPoster(config))(
      repo,
      pr.headRefOid,
      { state: 'success', description: `Evaluator: ship (round ${round})` },
      gateTargetUrl(config, ticket?.displayId ?? null),
    );
  }
  logger.info({ prNumber: pr.number, verdict: combined?.verdict ?? null, ticket: ticket?.displayId ?? null }, 'evaluator: reviewed a non-Robot PR');
  return combined;
}
