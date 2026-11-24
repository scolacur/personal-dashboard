import type Database from 'better-sqlite3';
import type { AgentWorkerConfig } from '../../shared/config';
import { dbPathFor } from '../../shared/config';
import { logger } from '../../shared/logger';
import {
  areaBusySkips,
  queuedBlockedByAgentState,
  queuedButUnrefined,
  robotQueueCandidates,
  runningCoderAreas,
  selectDispatchable,
  type RobotCandidate,
} from './select';
import { checkDbLockedFromCoder } from './privilege';
import { ensureWorktree, pruneWorktrees, removeWorktree, worktreeDirFor, type Worktree } from './workspace';
import { pushWip, deleteWipRef, restoreWip, type WipRef, type WipRestore } from './wip';
import { appendTail, runRobotSession, runStatusReport, type RobotSessionResult, type SessionSegment, type StatusReportResult } from './session';
import { currentEpisode, dispatchStart, firstWindow, reportFromTail } from './checkpoint';
import {
  checkTripwires,
  gitTreeSnapshotter,
  latestPlan,
  outcomeFrom,
  runProgressJudge,
  verifyFailureSignature,
  type JudgeInput,
  type JudgeResult,
  type ProgressCheckOutcome,
  type TreeSnapshotter,
} from './progress';
import { progressCheckLine, type ResumeContext, type RobotEventDetail } from '@dashboard/shared';
import {
  ensureRunsTable,
  startRun,
  finishRun,
  failedRunsForTicket,
  hashBody,
  updateRunProgress,
  updateRunAllowance,
  ticketsWithTerminalWipRef,
  clearWipRef,
} from './runs';
import { classifyFault, decideFault, isTurnCeiling, preflight, INTERRUPTED_SIGNATURE, type FaultClassification, type FaultPolicy } from './faults';
import { ABORT_HUNG, ABORT_SHUTDOWN, ABORT_SUPERSEDED, createRunOwnership, type RunOwnership } from './ownership';
import { RobotShutdown, timeout } from './shutdown';
import {
  activeDeployHold,
  activeMaintenanceHold,
  activeSessionLimitHold,
  ensureRobotStateTable,
  holdForSessionLimit,
  isDispatchPaused,
  pauseDispatch,
} from './state';
import { breakerPauseReason, breakerNotificationBody, recordDeterministicFailure, resetBreaker } from './breaker';
import { logMilestone, ROBOT_EVENT } from './events';
import { setAgentState, branchFor, completeTicket } from './board';
import { adoptedFrom, releaseAdoption } from '../evaluate/adoption';
import { notifyNeedsHuman, notifyAwaitingHuman, notifyLoop } from './notify';
import { checkBudget, publishBudgetPolicy, publishCapacityPolicy, type BudgetPolicy } from './budget';
import { reconcileStalledRuns } from './stall';
import { resumeAskHuman, askHumanResume } from './resume';
import { pendingEvaluatorBrief } from '../evaluate/brief';
import { pollInReviewPrs, defaultPrFetcher, type PrFetcher } from './pr-state';
import { checkRework } from './rework-guard';
import { defaultHandoffStarted, defaultHasCommit, watchForSupersession, type Supersession } from './supersede';
import { runPrStatusUpdate } from './pr-status';

/** PD-964: why a run parked at a progress check — the fields a `robot_checkpoint` and the checkpoint
 *  card need to say whether it was a tripwire, the judge, or the total cap. */
type ProgressCheckDetail = Pick<RobotEventDetail, 'progress' | 'checkedBy' | 'tripwire' | 'window' | 'turnsSoFar' | 'totalCap' | 'reason'>;

// Re-exported for existing importers (robot.spec.ts) now that these leaf helpers live in board.ts.
export { setAgentState, branchFor };

/**
 * The Robot loop orchestration (D-055, PD-342): one poll cycle. Selects dispatchable
 * `queue` tickets, and for each runs the full tracer-bullet path — worktree → coding
 * session → observe the filesystem hand-off → record the run → write the board state. The LOOP
 * is the sole `dashboard.db` writer; the coding session (uid-split) never touches it.
 *
 * C2 (PD-343): the blind retry cap is replaced by the fault-tier guardrail (faults.ts). Each
 * failed run is classified transient / deterministic / system-wide, and the loop retries with
 * backoff, parks, or pauses the whole loop accordingly. `ask_human` is a deliberate park
 * (awaiting-human), never a failure.
 *
 * C5 (PD-346): the four reaction bridges (retired `sortie-*.yml` Actions) fold in as native
 * pre-dispatch reconciliation — an in-process stall watchdog (stall.ts), DB-native ask_human resume (resume.ts),
 * and a review/conflict PR-state poll (pr-state.ts) — all reading/writing the board DB, no labels.
 */

/** Derive the fault policy from config (faults.ts is pure; this is the only adapter). */
function faultPolicy(config: AgentWorkerConfig): FaultPolicy {
  const { retryCap, promoteAfter, backoffBaseMs, backoffMaxMs, orphanCap } = config.robot;
  return { retryCap, promoteAfter, backoffBaseMs, backoffMaxMs, orphanCap };
}

/** The loop-wide budget ceiling this config enforces (PD-463). */
function budgetPolicy(config: AgentWorkerConfig): BudgetPolicy {
  const { budgetWindowMs, budgetTurns, budgetTokens } = config.robot;
  return { windowMs: budgetWindowMs, turns: budgetTurns, tokens: budgetTokens };
}

export interface RobotDeps {
  /** Injectable so orchestration tests never open a real worktree. */
  ensureWorktree?: (config: AgentWorkerConfig, branch: string) => Promise<Worktree>;
  removeWorktree?: (config: AgentWorkerConfig, wt: Worktree) => Promise<void>;
  /** PD-719: injectable so tests can observe pruning without touching a real worktrees dir. */
  pruneWorktrees?: (config: AgentWorkerConfig, keepDirs: ReadonlySet<string>) => string[];
  /** PD-737/T898: push a non-hand-off run's WIP to `robot-wip/t<id>` before the clone is dropped.
   *  Injectable so orchestration tests never shell out to git. Returns the ref+sha preserved, or
   *  null when nothing was worth preserving / the push failed. */
  pushWip?: (config: AgentWorkerConfig, wt: Worktree, ticketId: number) => Promise<WipRef | null>;
  /** PD-737/T898: delete a ticket's WIP ref once it hands off / goes terminal. Injectable so tests
   *  don't shell out. `cwd` is a clone with `origin` configured. */
  deleteWip?: (config: AgentWorkerConfig, ticketId: number, cwd: string) => Promise<void>;
  /** D-094/PD-737: resume a session that hit its turn ceiling for a short read-only status report.
   *  Injectable so tests never spawn a session. Must not throw (the real one never does). */
  statusReport?: (config: AgentWorkerConfig, c: RobotCandidate, wt: Worktree, sessionId: string) => Promise<StatusReportResult>;
  /** D-094/PD-737: on a Continue, restore the ticket's WIP ref into the prepared clone (rebased onto
   *  main where it applies). Injectable so tests don't shell out to git. */
  restoreWip?: (config: AgentWorkerConfig, wt: Worktree, ticketId: number) => Promise<WipRestore>;
  /** Injectable so tests never spawn a real coding session. Receives the resume context (C5) the
   *  loop derived for this dispatch (ask_human answer to inject), or undefined for a fresh run. */
  runSession?: (
    config: AgentWorkerConfig,
    c: RobotCandidate,
    wt: Worktree,
    resume: ResumeContext | undefined,
    /** PD-230: called as the session streams, with the live turn count (and, PD-898, the live
     *  token total when the stream carries usage). */
    onProgress?: (turns: number, tokens?: number) => void,
    /** PD-784/D-104: aborts the session on a graceful stop. The default (real) session wires it to
     *  the SDK; an injected session may trigger `shutdown.request()` to simulate a SIGTERM. */
    abort?: AbortController,
    /** PD-964: which window this is — a later window resumes the first window's session. */
    segment?: SessionSegment,
  ) => Promise<RobotSessionResult>;
  /** PD-964: the progress judge. Injectable so tests never call a model. Must not throw. */
  judge?: (config: AgentWorkerConfig, input: JudgeInput) => Promise<JudgeResult>;
  /** PD-964: working-tree fingerprints for the no-change tripwire and the judge's diff. Injectable so
   *  tests never shell out to git. */
  snapshotter?: (wt: Worktree) => TreeSnapshotter;
  /** PD-784/D-104: the live worker's in-flight run registry. Persisted across cycles by the loop
   *  owner (`startRobotJob`); a fresh one per call otherwise. Shared with `reconcileStalledRuns` so
   *  orphans are reclaimed by ownership, not age. */
  ownership?: RunOwnership;
  /** PD-784/D-104: the graceful-stop coordinator. Defaults to one wrapping `ownership`. */
  shutdown?: RobotShutdown;
  /** PD-924: PR lookup for the pre-dispatch rework guard. Injectable so tests never shell out. */
  fetchPr?: PrFetcher;
  /** PD-926: is `sha` a commit in the clone (the Robot's own push)? Injectable so tests skip git. */
  hasCommit?: (wt: Worktree, sha: string) => Promise<boolean>;
  /** PD-926: has the session reached a green verify? From then on a rework is never stopped. */
  handoffStarted?: (wt: Worktree) => boolean;
  now?: () => number;
}

/**
 * Run one Robot poll cycle. Returns the number of tickets dispatched this cycle. Fails closed
 * (dispatches nothing) if the DB-perms precondition for the uid-split is not satisfied, and does
 * nothing while the loop is paused by a system-wide fault (C2).
 */
export async function processRobotQueue(
  db: Database.Database,
  config: AgentWorkerConfig,
  deps: RobotDeps = {},
): Promise<number> {
  if (!config.robot.dispatchEnabled) return 0;

  // Fail-closed guard: never dispatch a Robot if dashboard.db isn't actually locked away from
  // the coding uid. Turns the uid-split from a documented assumption into a checked invariant.
  const lock = checkDbLockedFromCoder(dbPathFor(config), config);
  if (!lock.ok) {
    logger.error({ reason: lock.reason }, 'robot: DB-perms precondition failed — refusing to dispatch');
    return 0;
  }

  ensureRunsTable(db);
  ensureRobotStateTable(db);

  // Defined up here because the session-limit hold below is clock-driven and must use the SAME
  // injected clock the rest of the cycle does (the tests drive time through `deps.now`).
  const now = deps.now ?? Date.now;

  // PD-463: publish the ceiling the loop is enforcing, BEFORE the pause/hold gates below.
  // Deliberately above them: a paused loop is exactly when you need to confirm the running code is
  // the code you think it is. The agent-worker image is a build artifact, so a container recreated
  // without a rebuild silently runs old code (hit on 2026-08-06), and a non-null `budget` on
  // /system-status is the honest check for that — the heartbeat sha is not, since it reports the
  // grounding checkout, which pulls on boot. Publishing only while dispatching made that check
  // available only after the switch was already flipped, which is backwards for a pre-flight.
  const budget = budgetPolicy(config);
  publishBudgetPolicy(db, budget, now());
  publishCapacityPolicy(db, { concurrency: config.robot.concurrency }, now()); // D-103: auto-queue reads it

  // System-wide fault gate (C2): a prior auth/credit fault paused the whole loop. Stay inert until
  // a human resumes (C4) — auto-resuming would re-burn the board (the PD-320/#202 failure mode).
  const pause = isDispatchPaused(db);
  if (pause) {
    logger.warn('robot: dispatch is paused (system-wide fault) — not dispatching until resumed');
    return 0;
  }

  // Session-limit hold (PD-470): the account is out of quota until a time the provider stated. Wait
  // it out — the read CLEARS an expired hold, so the loop resumes on its own with no Unstick. This
  // is deliberately not `dispatch_paused`: a hold ends by itself, a pause waits for a human.
  const hold = activeSessionLimitHold(db, now());
  if (hold) {
    logger.info(
      { until: hold.until, reason: hold.reason },
      'robot: holding — provider session limit, dispatch resumes automatically at the reset',
    );
    return 0;
  }

  // Maintenance hold (D-081, D-082): a maintenance job needs the tree to itself, so dispatch is
  // held while one runs. Its own slot, not a `kind` on the hold above — see the block comment in
  // `state.ts` for why sharing one silently breaks both. No jobs are registered since PD-560, so
  // in practice this only fires for a hold a human opened from Dev Ops.
  const maintenance = activeMaintenanceHold(db, now());
  if (maintenance) {
    logger.info(
      { until: maintenance.until, reason: maintenance.reason },
      'robot: holding — maintenance window, dispatch resumes when it releases',
    );
    return 0;
  }

  // Deploy hold (PD-802, D-105): a Watchtower pre-update drain is about to recreate this container,
  // so nothing new may dispatch while it waits for in-flight runs to finish. Its own slot, not a
  // reason on the maintenance hold above — see the block comment in `state.ts` for why. Bounded by
  // `stallThresholdMs`, so a drain that dies cannot wedge dispatch shut; the new container also
  // releases a lingering hold on boot.
  const deploy = activeDeployHold(db, now());
  if (deploy) {
    logger.info(
      { until: deploy.until, reason: deploy.reason },
      'robot: holding — deploy drain, dispatch resumes once the new container boots',
    );
    return 0;
  }

  const doEnsure = deps.ensureWorktree ?? ((c, b) => ensureWorktree(c, b));
  const doRemove = deps.removeWorktree ?? ((c, w) => removeWorktree(c, w));
  const doPrune = deps.pruneWorktrees ?? ((c, keep) => pruneWorktrees(c, keep));
  const doPushWip = deps.pushWip ?? ((c, w, id) => pushWip(c, w, id));
  const doDeleteWip = deps.deleteWip ?? ((c, id, cwd) => deleteWipRef(c, id, cwd));
  const doStatusReport = deps.statusReport ?? ((c, cand, w, sid) => runStatusReport(c, cand, w, sid));
  const doRestoreWip = deps.restoreWip ?? ((c, w, id) => restoreWip(c, w, id));
  // NOTE the explicit wrapper: runRobotSession takes `runQuery` in the 5th slot, `onProgress` in
  // the 6th, the DB handle in the 7th and the abort controller in the 8th, so `deps.runSession`
  // (whose 5th arg IS onProgress) cannot be passed positionally. `db` is closed over from this cycle
  // — PD-564 needs it to build the decision-id tool, and dropping it costs the Robot its ability to
  // record a decision without anything else going red.
  const doRun =
    deps.runSession ??
    ((c, cand, w, resume, onProgress, abort, segment) => runRobotSession(c, cand, w, resume, undefined, onProgress, db, abort, segment));
  const doJudge = deps.judge ?? ((c, input) => runProgressJudge(c, input));
  const doSnapshotter = deps.snapshotter ?? ((w) => gitTreeSnapshotter(w.dir));
  const policy = faultPolicy(config);

  // PD-784/D-104: the ownership registry (persisted across cycles by the loop owner) and the
  // graceful-stop coordinator. Orphan reclaim keys off ownership, not age.
  const ownership = deps.ownership ?? createRunOwnership();
  const shutdown = deps.shutdown ?? new RobotShutdown(ownership);
  const fetchPr = deps.fetchPr ?? defaultPrFetcher(config);
  const hasCommit = deps.hasCommit ?? defaultHasCommit(config);
  const handoffStarted = deps.handoffStarted ?? defaultHandoffStarted;

  // ── C5 (PD-346): pre-dispatch reconciliation — the four folded-in bridges. These run BEFORE
  // selection so a ticket they re-queue is picked up in this SAME cycle. All are DB-native (no
  // labels); the PR-state poll is self-throttled to its own slower cadence.
  reconcileStalledRuns(db, config, policy, ownership, now()); // watchdog → ownership-based reclaim (D-104)
  resumeAskHuman(db, now()); // ask_human resume off the DB reply
  await pollInReviewPrs(db, config, now()); // review-/conflict-rework → one PR-state poll
  // PD-901: keep the live loop-status block on each open Robot PR in sync with the ticket timeline.
  // Best-effort and GitHub-bound — a failure is logged inside and retried next tick, never affecting
  // dispatch, so it is awaited for ordering but its outcome is deliberately ignored.
  await runPrStatusUpdate(db, config, now());

  // PD-467: name any ticket the selection query passed over purely because of a parked
  // `agent_state`. Runs after the reconciliation above, so a ticket those steps just re-queued is
  // not reported. Warn, not error — the ticket is not lost, it is stalled and invisible, and
  // silence is the actual defect.
  for (const t of queuedBlockedByAgentState(db)) {
    logger.warn(
      { ticketId: t.id, agentState: t.agentState },
      'robot: queued + robot-assigned + Ready but NOT dispatchable — parked agent_state; Unstick to clear',
    );
  }
  // D-091: the refinement backstop's skip, named for the same reason.
  for (const t of queuedButUnrefined(db)) {
    logger.warn(
      { ticketId: t.id },
      'robot: queued + robot-assigned but NOT dispatchable — un-refined after it was queued; ✓ Mark refined or move it out',
    );
  }

  // PD-951: the candidate set + the areas already running, read once and reused for both the
  // area-busy skip report below and the dispatch selection further down (one DB read per cycle).
  const candidates = robotQueueCandidates(db);
  const runningAreas = runningCoderAreas(db);
  // PD-951: name any ready candidate the per-area cap holds back this cycle, for the same reason
  // the two skips above are named — a card that can never dispatch reads exactly like an idle loop.
  for (const t of areaBusySkips(candidates, config.robot, 0, runningAreas)) {
    logger.warn(
      { ticketId: t.id, area: t.area },
      `robot: queued + robot-assigned + Ready but NOT dispatching this cycle — ${t.reason} (one Coder per area, PD-951)`,
    );
  }

  // PD-719: a run that did not hand off keeps its clone so the next dispatch can reuse its commits.
  // Drop the clones of tickets the Robot no longer has. Before any dispatch, and cycles never
  // overlap, so no clone here is in use.
  doPrune(config, new Set(robotClaimedBranches(db).map((b) => worktreeDirFor(config, b))));

  // PD-737/T898: the remote counterpart of the clone prune — delete the `robot-wip/t<id>` refs of
  // tickets that reached a terminal lane (incl. a manual close that never handed off), so scratch
  // refs don't pile up. `clearWipRef` forgets the record after, so this acts once per ticket. The
  // hand-off path deletes a ticket's WIP ref promptly; this is the backstop for the rest.
  for (const ticketId of ticketsWithTerminalWipRef(db)) {
    await doDeleteWip(config, ticketId, config.checkoutDir);
    clearWipRef(db, ticketId);
  }

  // Sequential within a cycle; the job loop's in-flight guard prevents overlapping cycles.
  // PD-951: `runningAreas` is passed so the per-area cap also counts Coders left running by a
  // prior cycle (true parallelism under ROBOT_CONCURRENCY > 1), not only same-cycle claims.
  const selected = selectDispatchable(candidates, config.robot, 0, runningAreas);
  let dispatched = 0;

  for (const candidate of selected) {
    // PD-784/D-104: a graceful stop was requested mid-cycle — dispatch nothing new. In-flight
    // sessions are aborted by the shutdown coordinator and unwind through the catch below.
    if (shutdown.requested) {
      logger.warn('robot: graceful stop in progress — not dispatching further this cycle');
      break;
    }

    // PD-463: the loop-wide budget ceiling, evaluated per candidate so a cycle with concurrency > 1
    // cannot step over it mid-cycle. It gates NEW dispatch only — an in-flight Robot is never
    // interrupted, because killing one mid-hand-off loses the work outright (D-046).
    const verdict = checkBudget(db, budget, now());
    if (verdict.breached) {
      // Reuses the one pause concept (C4 `dispatch_paused`) rather than adding a second halt path,
      // so the existing resume control clears it. Resuming is deliberate by construction: a human
      // resumes, or the window rolls far enough that the spend ages out.
      pauseDispatch(db, verdict.reason, now());
      notifyLoop(db, 'agent_needs_human', 'Robot budget ceiling reached', verdict.reason, now());
      logger.error({ reason: verdict.reason }, 'robot: budget ceiling reached — PAUSING dispatch');
      break;
    }

    // A system-wide fault earlier in THIS cycle paused the loop — stop before running any further
    // ticket, so no other ticket burns budget on the same broken auth/credit state.
    if (isDispatchPaused(db)) {
      logger.warn('robot: dispatch paused mid-cycle (system-wide fault) — stopping this cycle');
      break;
    }

    // PD-470: same idea for a session limit raised earlier in THIS cycle. Without this the loop
    // would keep dispatching into an exhausted quota, and every remaining ticket would collect a
    // failed run for a condition that has nothing to do with it.
    if (activeSessionLimitHold(db, now())) {
      logger.warn('robot: session limit hit mid-cycle — stopping this cycle until the reset');
      break;
    }

    // Pre-dispatch fault gate: park a budget-exhausted ticket without wasting a run, and hold a
    // ticket inside its transient-retry backoff window (leave it queued for a later cycle).
    const failures = failedRunsForTicket(db, candidate.id);
    const gate = preflight(failures, policy, now());
    if (gate.action === 'park') {
      logger.warn({ ticketId: candidate.id, reason: gate.reason }, 'robot: budget exhausted — parking (stuck)');
      setAgentState(db, candidate.id, 'stuck', now());
      logMilestone(db, candidate.id, ROBOT_EVENT.parked, { reason: gate.reason }, now());
      notifyNeedsHuman(db, candidate.id, 'Robot ticket stuck', gate.reason, now());
      continue;
    }
    if (gate.action === 'backoff') {
      logger.info({ ticketId: candidate.id, until: gate.until }, 'robot: within retry backoff — skipping this cycle');
      continue;
    }

    // C5: derive the ask_human resume context BEFORE writing the dispatched event below — so a human
    // answer that hasn't been consumed by a prior dispatch is injected into this run's prompt (the
    // coding uid is DB-blind), and a stale answer from a resolved episode is not. PR-feedback rework
    // needs no injection — the resume-aware prompt (Step 0) has the agent read the PR itself.
    const resume = askHumanResume(db, candidate.id);
    // PD-487: an Evaluator `revise` is the other kind of context this DB-blind session cannot read
    // off the branch. Both may be present — a human answered AND the Evaluator asked for changes —
    // so they compose rather than override.
    const brief = pendingEvaluatorBrief(db, candidate.id);

    // PD-924: a rework may have sat queued long enough for its PR to move on — merged, closed, or
    // re-pushed since the Evaluator's revise. Look once before spending a run on it (rework-guard.ts).
    const guard = await checkRework(db, candidate.id, candidate.repo, fetchPr, resume !== null && resume !== undefined);
    if (guard.action === 'complete') {
      completeTicket(db, candidate.id, now());
      logMilestone(db, candidate.id, ROBOT_EVENT.completed, { prNumber: guard.prNumber, via: 'merged_before_rework' }, now());
      logger.info({ ticketId: candidate.id, prNumber: guard.prNumber }, 'robot: PR merged while its rework was queued — completed, not dispatched');
      continue;
    }
    if (guard.action === 'park') {
      setAgentState(db, candidate.id, 'needs-human', now());
      logMilestone(db, candidate.id, ROBOT_EVENT.reworkSkipped, { prNumber: guard.prNumber, reason: guard.reason }, now());
      notifyNeedsHuman(db, candidate.id, 'Robot rework skipped', guard.reason, now());
      logger.warn({ ticketId: candidate.id, reason: guard.reason }, 'robot: rework skipped — PR closed');
      continue;
    }
    if (guard.action === 'back-to-review') {
      setAgentState(db, candidate.id, 'in-review', now());
      logMilestone(db, candidate.id, ROBOT_EVENT.reworkSkipped, { prNumber: guard.prNumber, reason: guard.reason }, now());
      logger.info({ ticketId: candidate.id, reason: guard.reason }, 'robot: rework skipped — PR head moved since the review');
      continue;
    }
    // D-094/PD-737, PD-964 (D-114): how this run starts — a Continue or Restart Steve chose, the loop's
    // own retry of a run a transient fault cut short (resume its work, keep its budget), or fresh.
    // Read BEFORE the run row below exists, since the newest run is what tells a retry apart.
    const start = dispatchStart(db, candidate.id);
    // PD-964: the episode's turns so far, across retries — the total cap and the window both count
    // from here.
    const episode = currentEpisode(db, candidate.id);
    const windowTurns = config.robot.checkpointWindowTurns;
    const totalCap = config.robot.checkpointTotalTurns;
    const first = firstWindow(episode.turnsUsed, windowTurns, totalCap);
    // PD-913 (D-111): a session PR the Robot adopted is reworked on Steve's branch, not robot/t<id>,
    // and the prompt is told whose branch it is.
    const adopted = adoptedFrom(db, candidate.id);
    let resumeCtx: ResumeContext | undefined =
      resume || brief || adopted
        ? {
            ...(resume ? { askHumanQuestion: resume.question, askHumanAnswer: resume.answer } : {}),
            ...(brief ? { evaluatorBrief: brief } : {}),
            ...(adopted ? { adoptedFrom: { prNumber: adopted.prNumber } } : {}),
          }
        : undefined;

    const branch = adopted?.branch ?? branchFor(candidate);

    // PD-964: a retry of a run that was cut short AT the total cap has no turns left to run. Park it
    // as the cap would have, without spending a session.
    if (first.turns <= 0) {
      const detail = { checkedBy: 'total_cap' as const, progress: 'progressing' as const, window: first.index, turnsSoFar: episode.turnsUsed, totalCap };
      const reason = progressCheckLine(detail);
      setAgentState(db, candidate.id, 'checkpoint', now());
      logMilestone(
        db,
        candidate.id,
        ROBOT_EVENT.checkpoint,
        { ...detail, reason, report: reportFromTail(undefined, 'the episode was already at its total turn cap when the retry came up'), reportFallback: true },
        now(),
      );
      notifyAwaitingHuman(db, candidate.id, 'Robot reached its total turn cap', `${reason}. Its work is saved — choose Continue or Restart.`, now());
      logger.info({ ticketId: candidate.id, turnsSoFar: episode.turnsUsed, totalCap }, 'robot: episode already at the total cap → checkpoint');
      continue;
    }

    // PD-406: snapshot the body this run runs against so a later max-turns fault can tell a futile
    // unchanged-body retry from a re-scoped one.
    const bodyHash = hashBody(candidate.body);
    setAgentState(db, candidate.id, 'working', now());
    // PD-432, PD-964: the run row's `max_turns` is where its current window ends — its next progress
    // check — moved forward each time it passes one (`updateRunAllowance`). The ticket's own
    // `max_turns` and `ROBOT_MAX_TURNS` no longer bound a run (D-114).
    const effectiveMaxTurns = first.turns;
    // The session reads its window length off the candidate; each window gets its own copy.
    const runCandidate: RobotCandidate = { ...candidate, maxTurns: effectiveMaxTurns };
    const runId = startRun(
      db,
      { ticketId: candidate.id, issueNumber: candidate.issueNumber, branch, bodyHash, maxTurns: effectiveMaxTurns },
      now(),
    );
    // PD-784/D-104: claim ownership of this run the instant its row exists, so the stall reconciler
    // never mistakes a run THIS process is executing for a dead-process orphan. The abort controller
    // is how a graceful stop interrupts the session below.
    const abort = new AbortController();
    ownership.begin({ runId, ticketId: candidate.id, branch, abort }, now());
    logMilestone(
      db,
      candidate.id,
      ROBOT_EVENT.dispatched,
      {
        branch,
        maxTurns: effectiveMaxTurns,
        window: first.index,
        turnsSoFar: episode.turnsUsed,
        totalCap,
        ...(start.kind === 'continue' || start.kind === 'restart' ? { reason: `checkpoint ${start.kind}` } : {}),
        ...(start.kind === 'retry' ? { reason: `retry — resuming the episode at ${episode.turnsUsed} turns` } : {}),
      },
      now(),
    );

    // Route a failed run (no-verify or errored) through the fault guardrail. Shared by the normal
    // path and the catch below so a thrown clone/spawn error is classified the same way.
    const handleFailure = (
      status: 'no-verify' | 'error',
      sessionId: string | undefined,
      error: string | undefined,
      // `outputTail` (PD-426) is the evidence a failed run leaves behind. The catch path below
      // has no session result and passes none, which stores null — correct: nothing was captured.
      // PD-918: `prUrl` when the run opened a PR even though it did not hand off, so a parked ticket
      // still points at its PR and the parked-PR merge sweep (pr-state.ts) can complete it.
      metrics: { turns?: number; tokens?: number; outputTail?: string; prUrl?: string } = {},
      // PD-737/T898: the WIP ref this run preserved its work to (or null). Recorded on the run row
      // and surfaced in whichever milestone this failure writes, so a human can `git fetch` it.
      wip: WipRef | null = null,
      // PD-784/D-104: an explicit classification, used by the graceful-stop path to record the run
      // as an `interrupted` infra fault rather than letting `classifyFault` read the abort error.
      classification?: FaultClassification,
    ): void => {
      const cls = classification ?? classifyFault({ verifyOk: false, error }, now());
      const decision = decideFault(cls, failures, policy, bodyHash, now());
      const wipDetail = wip ? { wipRef: wip.ref, wipSha: wip.sha } : {};
      finishRun(
        db,
        runId,
        {
          status,
          sessionId,
          error,
          faultTier: decision.tier,
          faultSignature: decision.signature,
          faultReason: decision.reason,
          turns: metrics.turns,
          tokens: metrics.tokens,
          outputTail: metrics.outputTail,
          prUrl: metrics.prUrl ?? null,
          wipRef: wip?.ref ?? null,
          wipSha: wip?.sha ?? null,
        },
        now(),
      );
      if (decision.action === 'pause') {
        // Zero per-ticket burn: this run is recorded system-wide (excluded from the cap) and the
        // ticket goes back to queued; the whole loop pauses so no other ticket burns budget either.
        pauseDispatch(db, decision.reason, now());
        setAgentState(db, candidate.id, 'queued', now());
        logMilestone(db, candidate.id, ROBOT_EVENT.paused, { tier: decision.tier, reason: decision.reason, ...wipDetail }, now());
        logger.error({ ticketId: candidate.id, reason: decision.reason }, 'robot: system-wide fault — PAUSING dispatch (no burn)');
      } else if (decision.action === 'wait') {
        // PD-470: zero per-ticket burn (the run is recorded but `countable` ignores this signature)
        // and the ticket goes straight back to queued — it did nothing wrong, the account ran out of
        // quota. The HOLD is what stops the loop grinding through the rest of the queue against a
        // wall, and it expires by itself, so this needs no human. `paused` is the honest milestone:
        // from the ticket's point of view the loop stopped; the detail says until when.
        holdForSessionLimit(db, decision.until, decision.reason, now(), decision.kind);
        setAgentState(db, candidate.id, 'queued', now());
        logMilestone(
          db,
          candidate.id,
          ROBOT_EVENT.paused,
          { tier: decision.tier, reason: decision.reason, until: decision.until, sessionLimit: true, ...wipDetail },
          now(),
        );
        logger.warn(
          { ticketId: candidate.id, until: decision.until, reason: decision.reason },
          'robot: provider session limit — HOLDING dispatch until the reset (no burn, auto-resumes)',
        );
      } else if (decision.action === 'park') {
        setAgentState(db, candidate.id, 'stuck', now());
        logMilestone(db, candidate.id, ROBOT_EVENT.parked, { tier: decision.tier, reason: decision.reason, ...wipDetail }, now());
        notifyNeedsHuman(db, candidate.id, 'Robot ticket stuck', decision.reason, now());
        logger.warn({ ticketId: candidate.id, tier: decision.tier, reason: decision.reason }, 'robot: fault → parking (stuck)');
        // Circuit breaker (t974, D-107): only a DETERMINISTIC-tier park feeds it — a transient
        // retry-cap park (tier 'transient') is this ticket's own budget running out, not evidence of
        // a systemic failure. Count distinct tickets; trip the loop-wide pause at `breakerFailures`.
        if (decision.tier === 'deterministic' && config.robot.breakerFailures > 0) {
          const streak = recordDeterministicFailure(
            db,
            { ticketId: candidate.id, title: candidate.title, signature: decision.signature },
            now(),
          );
          // Guard on the pause flag so a breaker that trips while the loop is already paused (for any
          // other reason) neither overwrites that reason (pauseDispatch keeps the first anyway) nor
          // re-fires the notification.
          if (streak.length >= config.robot.breakerFailures && !isDispatchPaused(db)) {
            pauseDispatch(db, breakerPauseReason(streak), now());
            notifyLoop(db, 'agent_needs_human', 'Robot circuit breaker tripped', breakerNotificationBody(streak), now());
            logger.error(
              { failures: streak.map((f) => f.ticketId), threshold: config.robot.breakerFailures },
              'robot: circuit breaker tripped — PAUSING dispatch after consecutive deterministic failures',
            );
          }
        }
      } else {
        setAgentState(db, candidate.id, 'queued', now());
        logMilestone(db, candidate.id, ROBOT_EVENT.fault, { tier: decision.tier, reason: decision.reason, ...wipDetail }, now());
        logger.warn({ ticketId: candidate.id, tier: decision.tier, reason: decision.reason }, 'robot: transient fault → will retry');
      }
    };

    let worktree: Worktree | undefined;
    // PD-964: the tree fingerprinter for this run's progress checks, and the check that parked it.
    let snapshotter: TreeSnapshotter | undefined;
    let check: ProgressCheckDetail | null = null;
    // PD-719: only a hand-off (the work is on GitHub) deletes the clone. A park, a fault or a
    // no-verify keeps it, so the commits survive into the next dispatch of this ticket.
    let handedOff = false;
    // PD-926: set when the rework's PR moved on under it and the session was stopped for that.
    let superseded: Supersession | null = null;
    let stopWatch: () => void = () => {};

    // PD-737/T898: preserve a non-hand-off run's WIP to `robot-wip/t<id>` before the clone is
    // dropped/reused. The clone is kept locally (PD-719), but a crashed run's UNCOMMITTED work is
    // discarded on the next reuse, and the local clone isn't reachable by a human or by PD-737's
    // Continue — so the work is also committed + pushed to a dedicated remote ref. Must never throw
    // (the real `pushWip` already swallows), and a null result just means nothing was preserved.
    const preserveWip = async (): Promise<WipRef | null> => {
      if (!worktree) return null;
      try {
        const push = doPushWip(config, worktree, candidate.id);
        // PD-784/D-104: during a graceful stop the container's stop-grace window is finite, so the
        // WIP push is time-boxed — a hung `git push` must not eat the whole window and get the
        // process SIGKILLed before the run is even closed. Outside a stop it runs unbounded as before.
        return shutdown.requested
          ? await Promise.race([push, timeout<WipRef | null>(config.robot.shutdownWipTimeoutMs, null)])
          : await push;
      } catch (err) {
        logger.warn({ err, ticketId: candidate.id }, 'robot: WIP push raised — ignored, run outcome unaffected');
        return null;
      }
    };

    // PD-784/D-104: why (if at all) this run's session was aborted. Read off the controller, not off
    // `shutdown.requested`, and checked on BOTH exits of the session — `runRobotSession` catches the
    // SDK's abort error itself and RETURNS `{ ok: false }`, so an aborted run usually never reaches
    // the `catch` below.
    const abortReason = (): string | null => (abort.signal.aborted ? String(abort.signal.reason) : null);
    /** Close a run a graceful stop aborted: a transient `interrupted` fault — re-queued, never counted
     *  (D-104) — after a time-boxed WIP push, so a deploy neither strands nor loses the work. */
    const closeInterrupted = async (
      sessionId: string | undefined,
      error: string | undefined,
      metrics: { turns?: number; tokens?: number; outputTail?: string } = {},
    ): Promise<void> => {
      logger.warn({ ticketId: candidate.id }, 'robot: in-flight session interrupted by graceful stop — re-queuing');
      handleFailure('error', sessionId, error, metrics, await preserveWip(), {
        tier: 'transient',
        signature: INTERRUPTED_SIGNATURE,
        reason: 'interrupted: worker graceful stop (SIGTERM)',
      });
    };
    /** The hung-session backstop (stall.ts) already closed this run and re-queued its ticket; closing
     *  it again would double-write it. Only salvage the WIP. Unreachable while sessions are awaited
     *  inside the cycle — live once a run can outlive its cycle. */
    /**
     * PD-926: the rework's PR merged, closed, or was pushed to by someone else mid-run, so the session
     * was stopped. Not a failure — no retry used, never the breaker — and no WIP is kept: the work was
     * for a PR state that no longer exists. The ticket goes where PD-924's dispatch guard would have
     * sent it.
     */
    const closeSuperseded = (
      s: Supersession,
      sessionId: string | undefined,
      metrics: { turns?: number; tokens?: number; outputTail?: string } = {},
    ): void => {
      finishRun(db, runId, { status: 'superseded', sessionId, faultReason: s.reason, ...metrics }, now());
      if (s.kind === 'merged') {
        completeTicket(db, candidate.id, now());
        logMilestone(db, candidate.id, ROBOT_EVENT.completed, { prNumber: s.prNumber, via: 'merged_during_rework' }, now());
      } else if (s.kind === 'closed') {
        setAgentState(db, candidate.id, 'needs-human', now());
        logMilestone(db, candidate.id, ROBOT_EVENT.reworkSkipped, { prNumber: s.prNumber, reason: s.reason }, now());
        notifyNeedsHuman(db, candidate.id, 'Robot rework stopped', s.reason, now());
      } else if (adopted) {
        // PD-913 (D-111): an adopted session PR has no Robot hand-off to be in review on. Someone else
        // pushing to it mid-rework is Steve taking it back, so it goes back to him.
        releaseAdoption(db, candidate.id, s.prNumber, 'you pushed to the PR while the Robot was reworking it, so it stopped', now());
      } else {
        // reworkSkipped also opens a fresh review cycle (reviewBoundary), so the new head is reviewed
        // without the stale review using up a round.
        setAgentState(db, candidate.id, 'in-review', now());
        logMilestone(db, candidate.id, ROBOT_EVENT.reworkSkipped, { prNumber: s.prNumber, reason: s.reason }, now());
      }
      logger.warn({ ticketId: candidate.id, kind: s.kind, reason: s.reason }, 'robot: rework superseded — session stopped');
    };
    const leaveReclaimed = async (): Promise<void> => {
      logger.warn({ ticketId: candidate.id, runId }, 'robot: session aborted as hung — run already reclaimed, not closing it again');
      await preserveWip();
    };

    /**
     * D-094/PD-737, PD-964 (D-114): the run stopped at a progress check — a tripwire, a judge verdict
     * other than `progressing`, or the total cap. Not a fault: get a status report from the same
     * session, save the work, park `checkpoint` for Steve's Continue / Restart. Burns no retry (a
     * `checkpoint` run is not a `no-verify`/`error` row, so `failedRunsForTicket` never counts it) and
     * never feeds the circuit breaker. The clone is kept, as for any non-hand-off exit (PD-719).
     */
    const handleCheckpoint = async (
      result: RobotSessionResult,
      metrics: { turns?: number; tokens?: number; outputTail?: string },
      check: ProgressCheckDetail,
    ): Promise<void> => {
      let report: string;
      let reportFallback = false;
      if (shutdown.requested) {
        // The stop-grace window is finite; spend it on the WIP push, not on a report.
        report = reportFromTail(result.outputTail, 'the worker was stopping, so no report was requested');
        reportFallback = true;
      } else if (!result.sessionId || !worktree) {
        report = reportFromTail(result.outputTail, 'the session id was not captured, so it could not be resumed');
        reportFallback = true;
      } else {
        let r: StatusReportResult;
        try {
          r = await doStatusReport(config, runCandidate, worktree, result.sessionId);
        } catch (err) {
          r = { error: err instanceof Error ? err.message : String(err) };
        }
        if (r.report) {
          report = r.report;
        } else {
          report = reportFromTail(result.outputTail, `the report step failed: ${r.error ?? 'no text'}`);
          reportFallback = true;
        }
      }
      const wip = await preserveWip();
      const why = progressCheckLine(check);
      finishRun(
        db,
        runId,
        {
          status: 'checkpoint',
          sessionId: result.sessionId,
          error: result.error,
          faultReason: why,
          statusReport: report,
          wipRef: wip?.ref ?? null,
          wipSha: wip?.sha ?? null,
          ...metrics,
        },
        now(),
      );
      setAgentState(db, candidate.id, 'checkpoint', now());
      logMilestone(
        db,
        candidate.id,
        ROBOT_EVENT.checkpoint,
        {
          ...check,
          reason: why,
          report,
          reportFallback,
          ...(metrics.turns !== undefined ? { turns: metrics.turns } : {}),
          ...(wip ? { wipRef: wip.ref, wipSha: wip.sha } : {}),
        },
        now(),
      );
      notifyAwaitingHuman(
        db,
        candidate.id,
        check.checkedBy === 'total_cap' ? 'Robot reached its total turn cap' : 'Robot stopped at a progress check',
        `${why}. Its work is saved — choose Continue or Restart.\n\n${report.slice(0, 400)}`,
        now(),
      );
      logger.info({ ticketId: candidate.id, turns: metrics.turns, why, reportFallback, wip: wip?.ref }, 'robot: progress check → checkpoint (no fault, no retry burned)');
    };

    try {
      // D-094/PD-737: Restart means a clean start, so the clone this ticket kept (PD-719) goes first —
      // otherwise reuse would carry the checkpointed run's commits into the "fresh" run. The WIP ref
      // is kept (D-094 §4).
      if (start.kind === 'restart') {
        await doRemove(config, { dir: worktreeDirFor(config, branch), branch });
      }
      worktree = await doEnsure(config, branch);
      ownership.attachWorktree(runId, worktree); // PD-784: so a graceful stop can reach it for WIP
      if (start.kind === 'continue' || start.kind === 'retry') {
        // PD-964: a retry resumes the interrupted run's own saved work — only when it saved some, so
        // a WIP ref left from before a Restart can never come back on its own.
        let restore: WipRestore = { restored: false, rebased: false };
        if (start.kind === 'continue' || start.restoreWip) {
          try {
            restore = await doRestoreWip(config, worktree, candidate.id);
          } catch (err) {
            logger.warn({ err, ticketId: candidate.id, start: start.kind }, 'robot: WIP restore raised — running from the tree as prepared');
          }
        }
        resumeCtx = { ...(resumeCtx ?? {}), checkpoint: { why: start.kind, report: start.report, ...restore } };
      }
      // PD-926: while a rework runs, stop it if its PR moves on (supersede.ts).
      if (guard.action === 'dispatch' && guard.rework && config.robot.supersedeCheckMs > 0) {
        const wt = worktree;
        stopWatch = watchForSupersession({
          repo: candidate.repo,
          prNumber: guard.rework.prNumber,
          baseline: guard.rework.head,
          intervalMs: config.robot.supersedeCheckMs,
          fetchPr,
          hasCommit: (sha) => hasCommit(wt, sha),
          handoffStarted: () => handoffStarted(wt),
          onSupersede: (s) => {
            superseded = s;
            abort.abort(ABORT_SUPERSEDED);
          },
        });
      }
      // PD-964 (D-114): the run proceeds in windows. Each window is one stretch of the SAME session
      // (the first starts it, later ones resume it), and at each window's end the progress check
      // decides: one more window, or park. A window that ends any other way (hand-off, ask_human, an
      // error, a voluntary stop, an abort) ends the run as before.
      const wt = worktree;
      snapshotter = doSnapshotter(wt);
      let treeBefore = await snapshotter.snapshot();
      let previousVerifyFailure: string | null = null;
      let windowIndex = first.index;
      let windowLength = first.turns;
      /** Run-wide totals across windows; the judge's own usage is folded in (it counts, D-064). */
      let runTurns = 0;
      let runTokens = 0;
      let sessionId: string | undefined;
      let tail = '';
      let plan: string | null = null;
      let segment: RobotSessionResult;
      for (;;) {
        const offsetTurns = runTurns;
        const offsetTokens = runTokens;
        segment = await doRun(
          config,
          { ...runCandidate, maxTurns: windowLength },
          wt,
          resumeCtx,
          // PD-230: persist live turn progress so the board shows a working run closing on its
          // check. The LOOP owns this write (the coding uid is DB-blind, D-039) — the session only
          // reports. PD-784/D-104: the same callback resets the run's hung-session clock.
          (turns, tokens) => {
            updateRunProgress(db, runId, offsetTurns + turns, tokens !== undefined ? offsetTokens + tokens : undefined);
            ownership.progress(runId, now());
          },
          abort,
          sessionId ? { resumeSessionId: sessionId, turnOffset: offsetTurns } : { turnOffset: offsetTurns },
        );
        runTurns += segment.turns ?? 0;
        runTokens += segment.tokens ?? 0;
        sessionId = segment.sessionId ?? sessionId;
        if (segment.outputTail) tail = appendTail(tail, segment.outputTail);
        plan = latestPlan(segment.transcript ?? []) ?? plan;

        // Only a window that ran out of turns reaches a progress check.
        const atWindowEnd = !segment.ok && isTurnCeiling(segment.error) && !segment.askHuman && !(segment.verifyOk && segment.prNumber !== undefined);
        if (!atWindowEnd || abort.signal.aborted) break;

        const turnsSoFar = episode.turnsUsed + runTurns;
        const base = { window: windowIndex, turnsSoFar, totalCap };
        if (turnsSoFar >= totalCap) {
          // The cap stops a run whatever the judge would say — and says that it was the cap.
          check = { ...base, checkedBy: 'total_cap', progress: 'progressing' };
          logMilestone(db, candidate.id, ROBOT_EVENT.progressCheck, { ...check, reason: progressCheckLine(check) }, now());
          break;
        }
        const treeAfter = await snapshotter.snapshot();
        const transcript = segment.transcript ?? [];
        const verifyFailure = verifyFailureSignature(transcript);
        const hit = checkTripwires({
          transcript,
          repeatLimit: config.robot.checkpointRepeatLimit,
          treeBefore,
          treeAfter,
          verifyFailure,
          previousVerifyFailure,
        });
        let judge: JudgeResult | null = null;
        if (!hit) {
          const diff = treeBefore && treeAfter ? await snapshotter.diff(treeBefore, treeAfter) : null;
          try {
            judge = await doJudge(config, { title: candidate.title, body: candidate.body, plan, diff, transcript, window: windowIndex, turnsSoFar });
          } catch (err) {
            judge = { verdict: 'error', reason: `the judge call raised: ${err instanceof Error ? err.message : String(err)}`, turns: 0, tokens: 0 };
          }
        }
        const outcome: ProgressCheckOutcome = outcomeFrom(hit, judge);
        runTurns += outcome.judgeTurns;
        runTokens += outcome.judgeTokens;
        updateRunProgress(db, runId, runTurns, runTokens);
        const turnsAfterCheck = episode.turnsUsed + runTurns;
        check = {
          window: windowIndex,
          turnsSoFar: turnsAfterCheck,
          totalCap,
          checkedBy: outcome.checkedBy,
          progress: outcome.verdict,
          ...(outcome.tripwire ? { tripwire: outcome.tripwire } : {}),
          reason: outcome.reason,
        };
        logMilestone(db, candidate.id, ROBOT_EVENT.progressCheck, check, now());
        logger.info({ ticketId: candidate.id, ...check }, `robot: progress check — ${progressCheckLine(check)}`);
        if (!outcome.proceed) break;
        // A graceful stop landed during the check: don't open another window. The stop path below
        // closes the run as an interrupt, and the retry resumes it (D-114 §6).
        if (abort.signal.aborted) break;
        if (!sessionId) {
          check = { ...check, progress: 'error', checkedBy: 'judge', reason: 'the session id was not captured, so the run cannot be resumed for another window' };
          break;
        }
        windowLength = Math.min(windowTurns, totalCap - turnsAfterCheck);
        if (windowLength <= 0) {
          check = { window: windowIndex, turnsSoFar: turnsAfterCheck, totalCap, checkedBy: 'total_cap', progress: 'progressing' };
          break;
        }
        // Passed: one more window, re-checked at its end.
        check = null;
        windowIndex += 1;
        treeBefore = treeAfter;
        previousVerifyFailure = verifyFailure;
        updateRunAllowance(db, runId, runTurns + windowLength);
      }
      // A window cut short with no result message (an abort) reports no turns: leave them undefined so
      // finishRun keeps the live count `updateRunProgress` wrote — the retry's episode total reads it.
      const result: RobotSessionResult = {
        ...segment,
        sessionId,
        turns: segment.turns === undefined ? undefined : runTurns,
        tokens: segment.tokens === undefined ? undefined : runTokens,
        outputTail: tail || undefined,
      };
      // Spread into finishRun on every terminal path, so the captured tail (PD-426) lands on the
      // run row before the `finally` below removes the worktree.
      // PD-918: the PR the run opened, if any, recorded on the run row whatever the outcome.
      const prUrl = result.prNumber !== undefined ? `https://github.com/${candidate.repo}/pull/${result.prNumber}` : undefined;
      const metrics = { turns: result.turns, tokens: result.tokens, outputTail: result.outputTail, ...(prUrl ? { prUrl } : {}) };
      // PD-917: the hand-off on DISK is authoritative, not the session's exit status (D-046 — the loop
      // never takes the session's word for success). A run that went green, pushed and opened its PR
      // and THEN errored (the turn ceiling while writing its run memory, PD-901; a late crash) has
      // handed off. Requiring `result.ok` here parked a finished PR as `stuck`. Both markers are wiped
      // when a clone is reused (`ensureWorktree`), so they can only have come from this run.
      const handoffReady = result.verifyOk && result.prNumber !== undefined;

      stopWatch();
      if (abortReason() === ABORT_HUNG) {
        await leaveReclaimed();
      } else if (abortReason() === ABORT_SUPERSEDED && superseded && !handoffReady && !result.askHuman) {
        closeSuperseded(superseded, result.sessionId, metrics);
      } else if (abortReason() === ABORT_SHUTDOWN && !handoffReady && !result.askHuman) {
        // A session that finished its hand-off (or asked its question) before the abort landed keeps
        // that outcome below; anything else the stop cut short is an interrupt, not a ticket failure.
        await closeInterrupted(result.sessionId, result.error, metrics);
      } else if (result.askHuman) {
        // Deliberate park (D-055 human-state labels): the Robot hit a real ambiguity and asked a
        // question. Not a failure — burns no budget; a human answers (Notification Center) and the
        // resume sweep re-queues it next cycle. Preserve WIP too (PD-737/T898): the next dispatch's
        // reuse discards any uncommitted work, and the question may have come after real edits.
        const wip = await preserveWip();
        finishRun(
          db,
          runId,
          { status: 'ask-human', sessionId: result.sessionId, faultReason: result.askHuman, wipRef: wip?.ref ?? null, wipSha: wip?.sha ?? null, ...metrics },
          now(),
        );
        setAgentState(db, candidate.id, 'awaiting-human', now());
        logMilestone(db, candidate.id, ROBOT_EVENT.askHuman, { question: result.askHuman, ...(wip ? { wipRef: wip.ref, wipSha: wip.sha } : {}) }, now());
        notifyAwaitingHuman(db, candidate.id, 'Robot asked a question', result.askHuman, now());
        logger.info({ ticketId: candidate.id, question: result.askHuman.slice(0, 200) }, 'robot: ask_human — parked (awaiting-human)');
      } else if (handoffReady && prUrl) {
        // PD-917: keep a late SDK error on the row and the milestone — the run handed off, but it did
        // not end cleanly, and that is worth seeing on the timeline.
        const lateError = result.ok ? undefined : (result.error ?? 'session ended with an error after hand-off');
        finishRun(db, runId, { status: 'handed-off', sessionId: result.sessionId, error: lateError, ...metrics }, now());
        handedOff = true;
        setAgentState(db, candidate.id, 'in-review', now());
        // Circuit breaker (t974, D-107): a successful hand-off breaks the "consecutive" chain, so the
        // deterministic-failure streak resets. Only a success does — a transient retry leaves it be.
        resetBreaker(db, now());
        dispatched++;
        logMilestone(db, candidate.id, ROBOT_EVENT.handoff, { branch, prUrl, ...(lateError ? { lateError } : {}) }, now());
        // PD-773: the Robot asked for Steve's visual check; the PR waits for it (see visual/gate.ts).
        if (result.visualReview) {
          logMilestone(db, candidate.id, ROBOT_EVENT.visualReviewRequested, { prNumber: result.prNumber, by: 'robot', reason: result.visualReview }, now());
        }
        logger.info({ ticketId: candidate.id, branch, prUrl }, 'robot: handed off PR');
      } else if (!result.ok && isTurnCeiling(result.error)) {
        // D-094/PD-737, PD-964: a window that ended at its turn limit and did not pass the progress
        // check is a checkpoint, not a failure — never `handleFailure`.
        await handleCheckpoint(
          result,
          metrics,
          check ?? { checkedBy: 'judge', progress: 'error', window: first.index, turnsSoFar: episode.turnsUsed + (result.turns ?? 0), totalCap, reason: 'the run stopped at its window end without a progress check' },
        );
      } else if (result.ok && !result.verifyOk) {
        // D-046 gate: the session ended without a green verify — withhold the red PR. The WIP is NOT
        // lost: preserve it to robot-wip/t<id> (PD-737/T898) before the clone could be reused/pruned,
        // so a human can `git fetch` it and PD-737's Continue can resume from it.
        handleFailure('no-verify', result.sessionId, undefined, metrics, await preserveWip());
      } else {
        handleFailure('error', result.sessionId, result.error, metrics, await preserveWip());
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stopWatch();
      if (abortReason() === ABORT_HUNG) {
        await leaveReclaimed();
      } else if (abortReason() === ABORT_SUPERSEDED && superseded) {
        closeSuperseded(superseded, undefined);
      } else if (abortReason() === ABORT_SHUTDOWN) {
        await closeInterrupted(undefined, msg);
      } else {
        logger.error({ err, ticketId: candidate.id }, 'robot: dispatch failed');
        // A thrown session may still have left work in the clone (if ensureWorktree got far enough).
        handleFailure('error', undefined, msg, {}, await preserveWip());
      }
    } finally {
      stopWatch();
      snapshotter?.dispose();
      ownership.end(runId); // PD-784: the run is terminal — the live process no longer owns it.
      if (worktree && handedOff) {
        // The work is on GitHub as a PR now, so the WIP ref is superseded — delete it (best-effort)
        // while the clone still exists, then drop the clone (PD-737/T898, PD-719).
        await doDeleteWip(config, candidate.id, worktree.dir);
        await doRemove(config, worktree);
      } else if (worktree) {
        logger.info({ ticketId: candidate.id, dir: worktree.dir }, 'robot: keeping the clone for the next dispatch (no hand-off)');
      }
    }
  }

  return dispatched;
}

/**
 * Branches of every ticket the Robot still has (`queue ∧ robot`, not archived), whatever its agent
 * state. Their clones are kept; every other clone is pruned (PD-719). Uses the same
 * `adoptedFrom ?? branchFor` as the dispatch path (PD-913), so the naming can never drift from it.
 */
export function robotClaimedBranches(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT id, github_issue_number AS issueNumber FROM agent_tickets
        WHERE archived_at IS NULL AND status = 'queue' AND assignee = 'robot'`,
    )
    .all() as { id: number; issueNumber: number | null }[];
  return rows.map(
    (r) => adoptedFrom(db, r.id)?.branch ?? branchFor({ id: r.id, issueNumber: r.issueNumber } as Parameters<typeof branchFor>[0]),
  );
}

