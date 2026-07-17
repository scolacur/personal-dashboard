import type Database from 'better-sqlite3';
import type { AgentWorkerConfig } from '../../shared/config';
import { dbPathFor } from '../../shared/config';
import { logger } from '../../shared/logger';
import { robotQueueCandidates, selectDispatchable, type RobotCandidate } from './select';
import { checkDbLockedFromCoder } from './privilege';
import { ensureWorktree, removeWorktree, type Worktree } from './workspace';
import { runRobotSession, type RobotSessionResult } from './session';
import type { ResumeContext } from './prompt';
import { ensureRunsTable, startRun, finishRun, failedRunsForTicket, hashBody } from './runs';
import { classifyFault, decideFault, preflight, type FaultPolicy } from './faults';
import { ensureRobotStateTable, isDispatchPaused, pauseDispatch } from './state';
import { logMilestone, ROBOT_EVENT } from './events';
import { setAgentState, branchFor } from './board';
import { notifyNeedsHuman, notifyAwaitingHuman } from './notify';
import { reconcileStalledRuns } from './stall';
import { resumeAskHuman, askHumanResume } from './resume';
import { pollInReviewPrs } from './pr-state';

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
  const { retryCap, promoteAfter, backoffBaseMs, backoffMaxMs } = config.robot;
  return { retryCap, promoteAfter, backoffBaseMs, backoffMaxMs };
}

export interface RobotDeps {
  /** Injectable so orchestration tests never open a real worktree. */
  ensureWorktree?: (config: AgentWorkerConfig, branch: string) => Promise<Worktree>;
  removeWorktree?: (config: AgentWorkerConfig, wt: Worktree) => Promise<void>;
  /** Injectable so tests never spawn a real coding session. Receives the resume context (C5) the
   *  loop derived for this dispatch (ask_human answer to inject), or undefined for a fresh run. */
  runSession?: (
    config: AgentWorkerConfig,
    c: RobotCandidate,
    wt: Worktree,
    resume: ResumeContext | undefined,
  ) => Promise<RobotSessionResult>;
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

  // System-wide fault gate (C2): a prior auth/credit fault paused the whole loop. Stay inert until
  // a human resumes (C4) — auto-resuming would re-burn the board (the PD-320/#202 failure mode).
  const pause = isDispatchPaused(db);
  if (pause) {
    logger.warn('robot: dispatch is paused (system-wide fault) — not dispatching until resumed');
    return 0;
  }

  const doEnsure = deps.ensureWorktree ?? ((c, b) => ensureWorktree(c, b));
  const doRemove = deps.removeWorktree ?? ((c, w) => removeWorktree(c, w));
  const doRun = deps.runSession ?? ((c, cand, w, resume) => runRobotSession(c, cand, w, resume));
  const now = deps.now ?? Date.now;
  const policy = faultPolicy(config);

  // ── C5 (PD-346): pre-dispatch reconciliation — the four folded-in bridges. These run BEFORE
  // selection so a ticket they re-queue is picked up in this SAME cycle. All are DB-native (no
  // labels); the PR-state poll is self-throttled to its own slower cadence.
  reconcileStalledRuns(db, config, policy, now()); // watchdog → in-process stall detection
  resumeAskHuman(db, now()); // ask_human resume off the DB reply
  await pollInReviewPrs(db, config, now()); // review-/conflict-rework → one PR-state poll

  // Sequential within a cycle; the job loop's in-flight guard prevents overlapping cycles.
  const selected = selectDispatchable(robotQueueCandidates(db), config.robot, 0);
  let dispatched = 0;

  for (const candidate of selected) {
    // A system-wide fault earlier in THIS cycle paused the loop — stop before running any further
    // ticket, so no other ticket burns budget on the same broken auth/credit state.
    if (isDispatchPaused(db)) {
      logger.warn('robot: dispatch paused mid-cycle (system-wide fault) — stopping this cycle');
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
    const resumeCtx: ResumeContext | undefined = resume
      ? { askHumanQuestion: resume.question, askHumanAnswer: resume.answer }
      : undefined;

    const branch = branchFor(candidate);
    // PD-406: snapshot the body this run runs against so a later max-turns fault can tell a futile
    // unchanged-body retry from a re-scoped one.
    const bodyHash = hashBody(candidate.body);
    setAgentState(db, candidate.id, 'working', now());
    const runId = startRun(db, { ticketId: candidate.id, issueNumber: candidate.issueNumber, branch, bodyHash }, now());
    logMilestone(db, candidate.id, ROBOT_EVENT.dispatched, { branch }, now());

    // Route a failed run (no-verify or errored) through the fault guardrail. Shared by the normal
    // path and the catch below so a thrown clone/spawn error is classified the same way.
    const handleFailure = (
      status: 'no-verify' | 'error',
      sessionId: string | undefined,
      error: string | undefined,
      metrics: { turns?: number; tokens?: number } = {},
    ): void => {
      const cls = classifyFault({ verifyOk: false, error });
      const decision = decideFault(cls, failures, policy, bodyHash);
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
        },
        now(),
      );
      if (decision.action === 'pause') {
        // Zero per-ticket burn: this run is recorded system-wide (excluded from the cap) and the
        // ticket goes back to queued; the whole loop pauses so no other ticket burns budget either.
        pauseDispatch(db, decision.reason, now());
        setAgentState(db, candidate.id, 'queued', now());
        logMilestone(db, candidate.id, ROBOT_EVENT.paused, { tier: decision.tier, reason: decision.reason }, now());
        logger.error({ ticketId: candidate.id, reason: decision.reason }, 'robot: system-wide fault — PAUSING dispatch (no burn)');
      } else if (decision.action === 'park') {
        setAgentState(db, candidate.id, 'stuck', now());
        logMilestone(db, candidate.id, ROBOT_EVENT.parked, { tier: decision.tier, reason: decision.reason }, now());
        notifyNeedsHuman(db, candidate.id, 'Robot ticket stuck', decision.reason, now());
        logger.warn({ ticketId: candidate.id, tier: decision.tier, reason: decision.reason }, 'robot: fault → parking (stuck)');
      } else {
        setAgentState(db, candidate.id, 'queued', now());
        logMilestone(db, candidate.id, ROBOT_EVENT.fault, { tier: decision.tier, reason: decision.reason }, now());
        logger.warn({ ticketId: candidate.id, tier: decision.tier, reason: decision.reason }, 'robot: transient fault → will retry');
      }
    };

    let worktree: Worktree | undefined;
    try {
      worktree = await doEnsure(config, branch);
      const result = await doRun(config, candidate, worktree, resumeCtx);
      const metrics = { turns: result.turns, tokens: result.tokens };

      if (result.askHuman) {
        // Deliberate park (D-055 human-state labels): the Robot hit a real ambiguity and asked a
        // question. Not a failure — burns no budget; a human answers (Notification Center) and the
        // resume sweep re-queues it next cycle.
        finishRun(db, runId, { status: 'ask-human', sessionId: result.sessionId, faultReason: result.askHuman, ...metrics }, now());
        setAgentState(db, candidate.id, 'awaiting-human', now());
        logMilestone(db, candidate.id, ROBOT_EVENT.askHuman, { question: result.askHuman }, now());
        notifyAwaitingHuman(db, candidate.id, 'Robot asked a question', result.askHuman, now());
        logger.info({ ticketId: candidate.id, question: result.askHuman.slice(0, 200) }, 'robot: ask_human — parked (awaiting-human)');
      } else if (result.ok && result.verifyOk && result.prNumber !== undefined) {
        const prUrl = `https://github.com/${candidate.repo}/pull/${result.prNumber}`;
        finishRun(db, runId, { status: 'handed-off', sessionId: result.sessionId, prUrl, ...metrics }, now());
        setAgentState(db, candidate.id, 'in-review', now());
        dispatched++;
        logMilestone(db, candidate.id, ROBOT_EVENT.handoff, { branch, prUrl }, now());
        logger.info({ ticketId: candidate.id, branch, prUrl }, 'robot: handed off PR');
      } else if (result.ok && !result.verifyOk) {
        // D-046 gate: the session ended without a green verify — leave WIP, don't publish a red PR.
        handleFailure('no-verify', result.sessionId, undefined, metrics);
      } else {
        handleFailure('error', result.sessionId, result.error, metrics);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, ticketId: candidate.id }, 'robot: dispatch failed');
      handleFailure('error', undefined, msg);
    } finally {
      if (worktree) await doRemove(config, worktree);
    }
  }

  return dispatched;
}
