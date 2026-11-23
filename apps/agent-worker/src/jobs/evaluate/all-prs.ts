import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import {
  buildEvaluatorPrompt,
  evaluatorSystemPrompt,
  HUMAN_REPLY_MARKER,
  ROBOT_EVENT,
  VISUAL_REVIEW_NOTIFICATION_PREFIX,
  securityEvaluatorSystemPrompt,
  type EvaluatorLens,
  type EvaluatorReport,
} from '@dashboard/shared';
import type { AgentWorkerConfig } from '../../shared/config';
import { buildContextPack } from '../../shared/context-pack';
import { logger } from '../../shared/logger';
import { logMilestone } from '../robot/events';
import { notify, notifyLoop } from '../robot/notify';
import { runEvaluatorTurn } from './evaluate-agent';
import { capDiff, combineReports, defaultDiffFetcher, type EvaluatePassDeps } from './evaluate';
import {
  finishEvaluatorRun,
  HEAD_VERDICT_ROUNDS,
  headEvaluated,
  latestLensReport,
  lensNeedsRun,
  lensStates,
  MAX_LENS_ERROR_RUNS,
  NO_TICKET,
  prRounds,
  startEvaluatorRun,
  updateEvaluatorRunProgress,
} from './evaluator-runs';
import { inReviewPrTargets } from '../robot/pr-state';
import { adoptableTicket, adoptedPrNumbers, branchTicket } from './adoption';
import { VISUAL_PENDING_DESCRIPTION, visualGate, visualRequested } from '../visual/gate';
import {
  defaultHeadShaFetcher,
  defaultStatusPoster,
  defaultStatusReader,
  gateForOutcome,
  gateReviewing,
  gateTargetUrl,
  isSteveApproval,
  type GateStatus,
  type StatusReader,
} from './review-gate';
import { blockingFindings, MAX_UNPARSEABLE_CHARS, parseEvaluatorReport } from './verdict';

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
 *  - **a timeline event** on each linked ticket — every ticket the PR names (PD-804);
 *  - **the same `review-gate` statuses as a Robot PR (PD-914)**: pending while reviewing, success on a
 *    ship from every lens, pending on a revise below the round cap, failure ("Needs Steve") on an
 *    escalate, a revise at the cap, or no verdict. {@link sessionGateFor} is the table. It never
 *    replaces the success Steve's approval posted (D-101 point 5): anything but a success is posted
 *    only after reading the head's current status, and a failed read posts nothing;
 *  - **needs-human** whenever nobody else will act: a failure, or a revise the Robot will not adopt
 *    (PD-913: no adoptable branch ticket, or adoption off). Before PD-914 a session PR at the round
 *    cap silently stopped being reviewed and nobody was told.
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
  /** PD-914: reads the head's current review-gate, so Steve's approval is never overwritten. */
  readStatus?: StatusReader;
  listPrs?: OtherPrLister;
  comment?: PrCommenter;
}

export const SKIP_LABEL = 'skip-evaluator';

/**
 * Why a PR is not reviewed by this path, or null when it should be.
 *
 * A `robot/*` PR is skipped ONLY when the Robot path (`evaluateOnePr`) will actually review it —
 * i.e. its number is a current `inReviewPrTargets` PR (passed in as `inReviewPrNumbers`). That set
 * IS the Robot path's target list, so a PR is reviewed by exactly one path and never both; a
 * `robot/*` PR whose ticket is NOT in-review (hand-finished on its own branch, reassigned, stuck,
 * needs-human, or no matching ticket) falls through to this path (PD-825, D-098/D-101).
 */
export function skipReason(pr: OtherPr, inReviewPrNumbers: ReadonlySet<number>): string | null {
  // PD-913: an adopted session PR is the Robot's too, so the test is ownership, not the branch prefix.
  if (inReviewPrNumbers.has(pr.number)) return 'robot PR (its own path)';
  if (pr.baseRefName !== 'main') return 'not into main';
  if (pr.isCrossRepository) return 'from a fork';
  if (pr.isDraft) return 'draft';
  if (pr.labels.some((l) => l.name === SKIP_LABEL)) return `labelled ${SKIP_LABEL}`;
  if (pr.files.length > 0 && pr.files.every((f) => f.path.startsWith('MEMORY/'))) return 'MEMORY-only';
  return null;
}

type LinkedTicket = { id: number; displayId: string; title: string; body: string | null };

const DISPLAY_ID = /\b([A-Z]{1,4})-(\d+)\b/g;

function lookupTicket(db: Database.Database, displayId: string): LinkedTicket | null {
  if (/^D-\d+$/.test(displayId)) return null; // a decision, not a ticket
  const row = db
    .prepare('SELECT id, display_id, title, body FROM agent_tickets WHERE display_id = ? AND archived_at IS NULL')
    .get(displayId) as { id: number; display_id: string; title: string; body: string | null } | undefined;
  return row ? { id: row.id, displayId: row.display_id, title: row.title, body: row.body } : null;
}

/**
 * The tickets a PR implements (PD-804): every existing display id in its branch (`pd-705-x`) and
 * title, in that order, de-duplicated. A PR often builds several tickets at once, and judging it
 * against only the first one reads the others' work as scope creep (PR #457 was escalated that way).
 *
 * The **body** is deliberately not a source when the branch or title names a ticket: descriptions
 * cite related tickets for context ("partly covers PD-613", "the Epic PD-605"), and treating those
 * as implemented would hold the PR to criteria it never claimed. With nothing in the branch or
 * title, the first existing id in the body is used, as before.
 */
export function linkedTickets(db: Database.Database, pr: Pick<OtherPr, 'headRefName' | 'title' | 'body'>): LinkedTicket[] {
  const named: string[] = [];
  const branch = /^([a-z]{1,4})-(\d+)(?:-|$)/i.exec(pr.headRefName);
  if (branch) named.push(`${branch[1]}-${branch[2]}`.toUpperCase());
  for (const m of (pr.title ?? '').matchAll(DISPLAY_ID)) named.push(`${m[1]}-${m[2]}`);

  const out: LinkedTicket[] = [];
  for (const displayId of new Set(named)) {
    const t = lookupTicket(db, displayId);
    if (t) out.push(t);
  }
  if (out.length > 0) return out;

  for (const m of (pr.body ?? '').matchAll(DISPLAY_ID)) {
    const t = lookupTicket(db, `${m[1]}-${m[2]}`);
    if (t) return [t];
  }
  return [];
}

/** "PD-1 (A)", "PD-1 (A) and PD-2 (B)", "PD-1 (A), PD-2 (B) and PD-3 (C)". */
function ticketList(tickets: readonly { displayId: string; title: string }[]): string {
  const named = tickets.map((t) => `${t.displayId} (${t.title})`);
  return named.length <= 1 ? (named[0] ?? '') : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
}

/**
 * What the Evaluator is told the PR must satisfy. One ticket: its title and body, unchanged. Several:
 * every ticket's criteria, framed as one change set, so a ticket's "out of scope — that is PD-x" is
 * read as satisfied when PD-x is in the set, not as a violation (PD-804).
 */
export function acceptanceBrief(tickets: readonly LinkedTicket[]): { title: string; body: string | null } {
  if (tickets.length === 1) return { title: tickets[0].title, body: tickets[0].body };
  return {
    title: tickets.map((t) => `${t.displayId}: ${t.title}`).join(' + '),
    body: [
      `MULTIPLE TICKETS: this PR implements ${tickets.length} tickets as one change set — ${tickets.map((t) => t.displayId).join(', ')}.`,
      'Judge it against all of them together. Work that any one of these tickets asks for is in scope. Where one',
      "ticket's Task, Out of scope or Done When defers work to another ticket in this list, that work being done",
      'here satisfies it rather than violating it. Only work none of them asks for is scope creep.',
      ...tickets.flatMap((t) => ['', '---', '', `# ${t.displayId} — ${t.title}`, '', t.body || '(no description)']),
    ].join('\n'),
  };
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

/**
 * The review-gate status for a session PR's outcome (PD-914). The Robot path's table
 * (`gateForOutcome`), except a revise below the cap: there is no Robot rework queued for a session
 * PR, so it says what will actually move it.
 */
export function sessionGateFor(
  report: EvaluatorReport | null,
  round: number,
  maxRounds: number,
  /** PD-913: minutes until the Robot takes it over, when it would; null when nothing will. */
  adoptAfterMin: number | null = null,
): GateStatus {
  if (report?.verdict === 'revise' && round < maxRounds) {
    const next = adoptAfterMin !== null ? `Robot takes over after ${adoptAfterMin} min idle` : 'push a fix';
    return { state: 'pending', description: `Evaluator requested changes (round ${round}); ${next}` };
  }
  return gateForOutcome(report, round, maxRounds);
}

/** What the PR comment's last line says will happen next, matching the status it gets. */
function nextStepLine(status: GateStatus, round: number, maxRounds: number, retryPending = false, adoptAfterMin: number | null = null): string {
  if (status.state === 'success') return 'review-gate is set to success for this commit.';
  if (retryPending) return 'review-gate is pending: the failed review is retried once on the next pass (PD-884).';
  const again = round < maxRounds ? ` A new push is reviewed again (up to ${maxRounds} rounds).` : ' No further automatic review.';
  if (status.state === 'failure') return `review-gate is set to failure: this needs Steve.${again}`;
  if (adoptAfterMin !== null) {
    return `review-gate is pending. If this branch gets no push for ${adoptAfterMin} minutes, the Robot takes over the rework.${again}`;
  }
  return `review-gate is pending: push a fix.${again}`;
}

/** The PR comment. Never carries HUMAN_REPLY_MARKER, whatever the agent quoted (see the header). */
export function verdictComment(
  report: EvaluatorReport | null,
  round: number,
  tickets: readonly { displayId: string; title: string }[],
  maxRounds: number,
  gate: { status: GateStatus; retryPending: boolean; adoptAfterMin?: number | null; visualHold?: boolean } = {
    status: sessionGateFor(report, round, maxRounds),
    retryPending: false,
  },
): string {
  const lines: string[] = ['<!-- evaluator:verdict -->'];
  const against = tickets.length > 0 ? ticketList(tickets) : 'the PR description (no linked ticket, so no acceptance criteria)';
  if (!report) {
    lines.push(
      `**Evaluator (round ${round}): no usable verdict.** The review failed, so it counts as neither ship nor revise.`,
      '',
      nextStepLine(gate.status, round, maxRounds, gate.retryPending),
    );
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
      gate.visualHold
        ? "review-gate is pending: the Evaluator shipped it, and it waits for Steve's visual check in Decisions."
        : nextStepLine(gate.status, round, maxRounds, gate.retryPending, gate.adoptAfterMin ?? null),
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

  // Mirror the Robot path's target list directly rather than re-deriving its condition, so a PR is
  // reviewed by exactly one path and never both (PD-825). A `robot/*` PR is left to the Robot path
  // iff its number is in this set; anything else `robot/*` is reviewed here.
  const inReviewTargets = inReviewPrTargets(db);
  // PD-913: plus session PRs the Robot adopted and has not handed back yet (queued or working).
  const inReviewPrNumbers = new Set([...inReviewTargets.map((t) => t.prNumber), ...adoptedPrNumbers(db)]);
  const inReviewTicketByPr = new Map(inReviewTargets.map((t) => [t.prNumber, t.ticketId]));

  const lenses: EvaluatorLens[] = config.evaluator.securityEnabled ? ['code', 'security'] : ['code'];

  const sorted = [...prs].sort((a, b) => a.number - b.number);
  for (const p of sorted) {
    if (p.headRefName.startsWith('robot/') && inReviewPrNumbers.has(p.number)) {
      logger.info(
        { prNumber: p.number, ticketId: inReviewTicketByPr.get(p.number) },
        `evaluator: skipping robot PR #${p.number} — owned by the Robot path (ticket ${inReviewTicketByPr.get(p.number)})`,
      );
    }
  }

  // A head is reviewed while any enabled lens still owes a run on it (no verdict, retry not yet
  // used), and while the PR is under its distinct-head round cap (PD-884).
  const pr = sorted.find(
    (p) =>
      skipReason(p, inReviewPrNumbers) === null &&
      !headEvaluated(db, p.number, p.headRefOid, lenses) &&
      prRounds(db, p.number) < config.evaluator.maxRounds,
  );
  if (!pr) return undefined;

  // Per-lens state over THIS head. Only the lenses still owing a run are re-run; a lens that already
  // decided this head (shipped / revised / escalated, or errored its retry out) is folded in from the
  // DB rather than re-run (PD-884), mirroring the Robot path.
  const select = { prNumber: pr.number, headSha: pr.headRefOid };
  const priorStates = lensStates(db, select);
  const needed = lenses.filter((l) => lensNeedsRun(priorStates.get(l), HEAD_VERDICT_ROUNDS));

  // A retry on the same head keeps its round; only a new head advances the PR-level counter.
  const round = priorStates.size > 0 ? prRounds(db, pr.number) : prRounds(db, pr.number) + 1;
  const tickets = linkedTickets(db, pr);
  // An evaluator run row has one ticket; the first is the PR's primary (its branch, else its title).
  const ticketId = tickets[0]?.id ?? NO_TICKET;
  const repo = config.githubRepo;

  const runIds = new Map<EvaluatorLens, number>();
  for (const lens of needed) {
    runIds.set(lens, startEvaluatorRun(db, { ticketId, prNumber: pr.number, round, model: config.evaluator.model, lens, headSha: pr.headRefOid }, now));
    for (const t of tickets) logMilestone(db, t.id, ROBOT_EVENT.evaluating, { round, prNumber: pr.number, lens }, now);
  }

  // The verdict must belong to the commit that was read. A push between the listing and the diff
  // makes this review stale: drop it, and the next pass reviews the new head.
  const head = await (deps.fetchHeadSha ?? defaultHeadShaFetcher(config))(repo, pr.number);
  const rawDiff = head === pr.headRefOid ? await (deps.fetchDiff ?? defaultDiffFetcher(config))(repo, pr.number) : null;
  if (rawDiff === null) {
    for (const id of runIds.values()) finishEvaluatorRun(db, id, { error: head === pr.headRefOid ? 'diff fetch failed' : 'head moved before review' }, now);
    return null;
  }
  // PD-914: the gate, posted on the exact commit that was read. Anything but a success first checks
  // the head's current status, so Steve's approval is never replaced, and a failed read posts nothing.
  const gateUrl = gateTargetUrl(config, tickets[0]?.displayId ?? null);
  const postGate = async (status: GateStatus): Promise<void> => {
    if (!config.evaluator.reviewGateToken) return;
    if (status.state !== 'success') {
      const read = await (deps.readStatus ?? defaultStatusReader(config))(repo, pr.headRefOid);
      if (!read.ok || isSteveApproval(read.current)) {
        logger.info(
          { prNumber: pr.number, state: status.state, reason: read.ok ? 'steve-approved' : 'read-failed' },
          'evaluator: leaving review-gate as it is',
        );
        return;
      }
    }
    await (deps.postStatus ?? defaultStatusPoster(config))(repo, pr.headRefOid, status, gateUrl);
  };
  await postGate(gateReviewing(round));

  const { diff, truncated } = capDiff(rawDiff);
  const brief = tickets.length > 0 ? acceptanceBrief(tickets) : null;
  const userPrompt = buildEvaluatorPrompt({
    title: brief ? brief.title : pr.title,
    body: brief
      ? brief.body
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

  // Start each lens's decision from what this head already holds: a lens we are NOT re-running folds
  // in its latest verdict (so a lens that already shipped is not read as a missing verdict); a lens
  // that errored its retry out folds in as null and keeps the PR from passing (PD-884).
  const reports = new Map<EvaluatorLens, EvaluatorReport | null>();
  for (const l of lenses) {
    if (!needed.includes(l)) reports.set(l, latestLensReport(db, select, l));
  }

  for (const lens of needed) {
    const runId = runIds.get(lens)!;
    const system = lens === 'security' ? securityEvaluatorSystemPrompt(contextPack) : evaluatorSystemPrompt(contextPack);
    const result = await (deps.runAgent ?? runEvaluatorTurn)(config, system, userPrompt, (t, k) =>
      updateEvaluatorRunProgress(db, runId, t, k),
    );
    const report = result.ok ? parseEvaluatorReport(result.text) : null;
    finishEvaluatorRun(
      db,
      runId,
      report
        ? { report, turns: result.turns, tokens: result.tokens }
        : {
            // PD-884: keep the full reply (bounded), not a 500-char head — the tail is usually where
            // the malformed JSON or truncation is.
            error: result.ok ? `unparseable report: ${result.text.slice(0, MAX_UNPARSEABLE_CHARS)}` : result.text || 'agent error',
            turns: result.turns,
            tokens: result.tokens,
          },
      now,
    );
    if (report) {
      for (const t of tickets) {
        logMilestone(db, t.id, ROBOT_EVENT.evaluated, {
          verdict: report.verdict,
          findings: report.findings.length,
          blockingFindings: blockingFindings(report).length,
          round,
          prNumber: pr.number,
          reason: report.summary,
          lens,
        }, now);
      }
    }
    if (report && lens === 'security' && report.findings.some((f) => f.kind === 'secret')) {
      notifyLoop(db, 'agent_needs_human', `Possible secret in PR #${pr.number}: rotate it`, 'The security reviewer found a credential in a PR. The repo is public, so treat it as leaked: rotate it now, then remove it from the branch.', now);
    }
    reports.set(lens, report);
  }

  // One decision from every lens (fresh this pass or folded). Any missing verdict means no pass.
  const combined = combineReports(lenses.map((l) => reports.get(l) ?? null));
  // PD-884 x PD-914: a lens with no verdict on this head is either waiting on its one retry (the next
  // pass re-runs only that lens, so the gate stays pending and Steve is not paged yet) or has used it
  // (terminal: failure naming the lens, and the one needs-human notification).
  // PD-913: a revise the Robot will pick up after the idle window needs no alert; say so instead.
  const adoptAfterMin =
    config.evaluator.adopt && adoptableTicket(db, pr.headRefName) ? Math.round(config.evaluator.adoptIdleMs / 60_000) : null;
  const finalStates = lensStates(db, select);
  const missing = lenses.filter((l) => (finalStates.get(l)?.verdictRuns ?? 0) === 0);
  const exhausted = missing.filter((l) => (finalStates.get(l)?.errorRuns ?? 0) >= MAX_LENS_ERROR_RUNS);
  const retryPending = !combined && missing.length > 0 && exhausted.length === 0;
  let status: GateStatus;
  if (retryPending) {
    status = { state: 'pending', description: `Evaluator: ${missing.join(' and ')} review produced no verdict; retrying once` };
  } else if (!combined && exhausted.length > 0) {
    status = gateForOutcome(null, round, config.evaluator.maxRounds, { lens: exhausted[0], retryUsed: true });
    if (exhausted.length > 1) status = { ...status, description: status.description.replace(`${exhausted[0]} review`, `${exhausted.join(' and ')} reviews`) };
  } else {
    status = sessionGateFor(combined, round, config.evaluator.maxRounds, adoptAfterMin);
  }

  // PD-915: the visual-review gate, as on Robot PRs. It lives on the branch ticket; with no branch
  // ticket there is nowhere to record the request or Steve's answer, so there is no gate. A ship
  // waits at pending until he approves a decision made after this review started (`now`).
  const visualTicket = branchTicket(db, pr.headRefName);
  const visualAsk = [...reports.values()].find((r) => r?.visualReview)?.visualReview;
  if (visualAsk && visualTicket && !visualRequested(db, visualTicket.id, pr.number)) {
    logMilestone(db, visualTicket.id, ROBOT_EVENT.visualReviewRequested, { prNumber: pr.number, by: 'evaluator', reason: visualAsk }, now);
  }
  let visualHold = false;
  if (status.state === 'success' && config.visual.enabled && visualTicket) {
    const vg = visualGate(db, visualTicket.id, pr.number, now);
    if (vg === 'pending' || vg === 'rejected') {
      visualHold = true;
      status = { state: 'pending', description: VISUAL_PENDING_DESCRIPTION };
      notify(
        db,
        'agent_visual_review',
        visualTicket.id,
        `${VISUAL_REVIEW_NOTIFICATION_PREFIX} PR #${pr.number} (${visualTicket.displayId})`,
        'The Evaluator shipped it, and it was flagged for your visual check. Approve or request changes in Decisions.',
        now,
      );
    }
  }

  await (deps.comment ?? defaultPrCommenter(config))(
    repo,
    pr.number,
    verdictComment(combined, round, tickets, config.evaluator.maxRounds, { status, retryPending, adoptAfterMin, visualHold }),
  );
  await postGate(status);
  const robotWillTakeIt = combined?.verdict === 'revise' && status.state === 'pending' && adoptAfterMin !== null;
  // A visual hold already notified (agent_visual_review); a second, generic alert would be noise.
  if (status.state !== 'success' && !retryPending && !robotWillTakeIt && !visualHold) {
    notifySessionPrNeedsHuman(db, repo, pr.number, status, tickets[0] ?? null, now);
  }
  logger.info(
    { prNumber: pr.number, headRef: pr.headRefName, verdict: combined?.verdict ?? null, tickets: tickets.map((t) => t.displayId) },
    'evaluator: reviewed a PR via the all-PRs path',
  );
  return combined;
}

/**
 * PD-914: tell Steve a session PR is waiting on him. On its primary ticket when it has one (the
 * ticket-scoped dedup keeps it to one unread per ticket), else loop-wide, titled by PR and round so
 * each distinct wait is its own notification.
 */
function notifySessionPrNeedsHuman(
  db: Database.Database,
  repo: string,
  prNumber: number,
  status: GateStatus,
  ticket: { id: number; displayId: string; title: string } | null,
  now: number,
): void {
  const url = `https://github.com/${repo}/pull/${prNumber}`;
  const label = ticket ? ` (${ticket.displayId}: ${ticket.title})` : '';
  const title = `PR #${prNumber}${label}: ${status.description}`;
  const body = `The Evaluator reviewed this session PR and it is waiting on you: ${url}`;
  if (ticket) notify(db, 'agent_needs_human', ticket.id, title, body, now);
  else notifyLoop(db, 'agent_needs_human', title, body, now);
}
