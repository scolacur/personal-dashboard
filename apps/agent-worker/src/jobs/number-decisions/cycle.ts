import type Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  DECISIONS_INDEX,
  loadDecisions,
  loadProvisionalDecisions,
  renderDecisionsIndex,
  type ProvisionalDecision,
} from '../../shared/decisions';
import { logger } from '../../shared/logger';
import { notifyLoop } from '../robot/notify';
import { applyAssignments } from './apply';
import { assignNumbers, type Assignment } from './numbering';

/**
 * The decision-numbering cycle (PD-498, D-078). Deterministic end to end — **no LLM anywhere in it**.
 * A rename and a regenerated index need no judgement, and an agent here would be a token cost with a
 * non-deterministic failure mode attached to the project's decision record.
 *
 * **It runs inside an already-open maintenance hold** (PD-498). Taking the hold and draining
 * in-flight Robot runs belong to `jobs/maintenance/coordinator.ts`, which owns the window; this job
 * only does the work:
 *
 *   1. Assign `D-NNN` in merge order, apply the renames, regenerate the index.
 *   2. Branch, commit, push, open a PR, wait for CI, **admin-merge**.
 *
 * On a red `verify` the PR is left open and a notification is raised. `--admin` skips the *approval*
 * requirement, never a failing check: a daily mechanical-rename PR is the definition of a rubber
 * stamp, but a red one means the rewrite broke something and a human should look.
 */

/** Runs a command, resolving `{ stdout }` or rejecting. Injected so the cycle is testable without git. */
export type CommandRunner = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string }>;

export interface CycleDeps {
  run: CommandRunner;
  /** Number of Robot runs currently in flight — re-checked as a guard, not waited on. */
  inFlightRuns: () => number;
  /** Resolves after `ms`. Injected so a test does not actually wait. */
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface CycleConfig {
  repoRoot: string;
  githubRepo: string;
  /** How long to wait for CI on the cycle's own PR before giving up and leaving it open. */
  ciTimeoutMs: number;
  ciPollMs: number;
}

export type CycleOutcome =
  | { status: 'nothing-to-do' }
  | { status: 'runs-in-flight'; inFlight: number }
  | { status: 'merged'; prNumber: number; assignments: Assignment[] }
  | { status: 'ci-red'; prNumber: number; assignments: Assignment[] }
  | { status: 'ci-timeout'; prNumber: number; assignments: Assignment[] };

/**
 * Provisional decisions in **merge order** — the order the commits that ADDED them landed on the
 * branch, which is what D-078 means by numbering in merge order.
 *
 * Not the inbox's own filename order: that is alphabetical by ticket, so a decision authored on
 * PD-600 last week would take a number after one authored on PD-383 today purely because 383 < 600.
 * Number order is meant to be chronological — that is the entire reason the index needs no date
 * column.
 *
 * A file git cannot date (never committed, or a shallow clone that does not reach its commit) sorts
 * **last**, on the reasoning that an undatable file is almost always one added just now.
 */
export async function inMergeOrder(
  provisional: readonly ProvisionalDecision[],
  deps: Pick<CycleDeps, 'run'>,
  cwd: string,
): Promise<ProvisionalDecision[]> {
  const dated = await Promise.all(
    provisional.map(async (d) => {
      try {
        const { stdout } = await deps.run('git', ['log', '--diff-filter=A', '--format=%ct', '-1', '--', d.file], { cwd });
        const ts = Number(stdout.trim());
        return { d, ts: Number.isFinite(ts) && ts > 0 ? ts : Number.MAX_SAFE_INTEGER };
      } catch {
        return { d, ts: Number.MAX_SAFE_INTEGER };
      }
    }),
  );
  // Tie-break on id so two decisions in one commit — which happens, a grill can settle two things —
  // get a stable order rather than whatever Promise.all happened to produce.
  return dated.sort((a, b) => a.ts - b.ts || a.d.id.localeCompare(b.d.id)).map((x) => x.d);
}


/** `verify`'s conclusion on the cycle's own PR: `pass`, `fail`, or `pending`. */
async function ciState(deps: CycleDeps, config: CycleConfig, prNumber: number): Promise<'pass' | 'fail' | 'pending'> {
  const { stdout } = await deps.run('gh', ['pr', 'checks', String(prNumber), '--repo', config.githubRepo], {
    cwd: config.repoRoot,
  });
  // `gh pr checks` exits non-zero when anything is failing or pending, so the runner must tolerate a
  // non-zero exit for this one call; the text is what carries the answer.
  if (/\bfail\b/.test(stdout)) return 'fail';
  if (/\bpending\b/.test(stdout)) return 'pending';
  return 'pass';
}

/**
 * Run one consolidation pass.
 *
 * **The caller must already hold dispatch.** Since PD-498's coordinator, the maintenance hold is
 * the scheduled thing and this runs *inside* an open one — it no longer takes or releases the hold,
 * and no longer drains. Both moved to `jobs/maintenance/coordinator.ts` so a second maintenance job
 * inherits them instead of re-deriving them.
 *
 * Safe to call with an empty inbox; that is the common case and it returns immediately.
 */
export async function runNumberingCycle(
  db: Database.Database,
  config: CycleConfig,
  deps: CycleDeps,
): Promise<CycleOutcome> {
  const provisional = loadProvisionalDecisions(config.repoRoot);
  if (provisional.length === 0) return { status: 'nothing-to-do' };

  {
    // Belt-and-braces, not the gate: the coordinator drains before opening the window, but this job
    // rewrites files repo-wide and the cost of doing that under a live Robot is a conflict on
    // someone else's PR. Cheap to re-check what we are about to rely on.
    const stillRunning = deps.inFlightRuns();
    if (stillRunning > 0) {
      logger.warn({ inFlight: stillRunning }, 'numbering: runs in flight inside the hold — skipping');
      notifyLoop(
        db,
        'agent_needs_human',
        'Decision consolidation skipped — runs were in flight inside the hold',
        `${stillRunning} run(s) were still running when the hold opened. ` +
          `${provisional.length} decision(s) stay provisional until the next hold.`,
        deps.now(),
      );
      return { status: 'runs-in-flight', inFlight: stillRunning };
    }
  }

  {
    const ordered = await inMergeOrder(provisional, deps, config.repoRoot);
    const assignments = assignNumbers(loadDecisions(config.repoRoot), ordered);
    const result = applyAssignments(config.repoRoot, assignments);

    // Regenerate the index over the post-rename tree. The inbox is empty now, so every entry lands
    // in the numbered list and the "Awaiting a number" section disappears until the next author.
    writeFileSync(
      path.join(config.repoRoot, DECISIONS_INDEX),
      renderDecisionsIndex(loadDecisions(config.repoRoot), loadProvisionalDecisions(config.repoRoot)),
      'utf8',
    );

    if (result.dangling.length > 0) {
      // Left as-is, deliberately — see D-TMP-PD498a. A citation with no decision behind it is
      // usually a PR that was open across a previous cycle, and inventing a target would bury it.
      notifyLoop(
        db,
        'agent_needs_human',
        'Decision numbering found citations with no decision behind them',
        `${result.dangling.join(', ')} — cited in the repo but absent from the inbox. Left unchanged; fix by hand.`,
        deps.now(),
      );
    }

    const branch = `numbering/${new Date(deps.now()).toISOString().slice(0, 10)}-${assignments[0].id.toLowerCase()}`;
    const title = `chore(decisions): number ${assignments.map((a) => a.id).join(', ')}`;
    const body = [
      'Mechanical renumbering by the decision-numbering cycle (PD-498, D-078). No LLM involved.',
      '',
      ...assignments.map((a) => `- \`${a.from.id}\` → **${a.id}** — ${a.from.title}`),
      '',
      `Citations rewritten in ${result.rewritten.length} file(s).`,
      ...(result.dangling.length > 0 ? ['', `⚠ Left unchanged (no decision behind them): ${result.dangling.join(', ')}`] : []),
    ].join('\n');

    const cwd = config.repoRoot;
    await deps.run('git', ['checkout', '-b', branch], { cwd });
    await deps.run('git', ['add', '--', 'DECISIONS', DECISIONS_INDEX, ...result.rewritten], { cwd });
    await deps.run('git', ['commit', '-m', title], { cwd });
    await deps.run('git', ['push', '-u', 'origin', branch], { cwd });
    const { stdout: prOut } = await deps.run(
      'gh',
      ['pr', 'create', '--repo', config.githubRepo, '--title', title, '--body', body, '--head', branch],
      { cwd },
    );
    const prNumber = Number(/\/pull\/(\d+)/.exec(prOut.trim())?.[1]);
    if (!Number.isFinite(prNumber)) throw new Error(`could not read a PR number out of: ${prOut.trim()}`);

    const ciDeadline = deps.now() + config.ciTimeoutMs;
    for (;;) {
      const state = await ciState(deps, config, prNumber);
      if (state === 'pass') break;
      if (state === 'fail') {
        logger.error({ prNumber }, 'numbering: CI red — leaving the PR open for a human');
        notifyLoop(
          db,
          'agent_needs_human',
          `Decision numbering PR #${prNumber} is red`,
          'The renumbering PR failed `verify` and was NOT merged. It is open for review. Decisions stay provisional until it lands.',
          deps.now(),
        );
        return { status: 'ci-red', prNumber, assignments };
      }
      if (deps.now() >= ciDeadline) {
        logger.warn({ prNumber }, 'numbering: CI still pending at the deadline — leaving the PR open');
        notifyLoop(
          db,
          'agent_needs_human',
          `Decision numbering PR #${prNumber} never finished CI`,
          'Checks were still pending at the deadline. The PR is open and unmerged.',
          deps.now(),
        );
        return { status: 'ci-timeout', prNumber, assignments };
      }
      await deps.sleep(config.ciPollMs);
    }

    // Admin-merge: skips the APPROVAL requirement only. CI is green above — this never merges red.
    await deps.run('gh', ['pr', 'merge', String(prNumber), '--repo', config.githubRepo, '--squash', '--admin'], { cwd });
    logger.info({ prNumber, assigned: assignments.map((a) => a.id) }, 'numbering: cycle complete');
    return { status: 'merged', prNumber, assignments };
  }
}
