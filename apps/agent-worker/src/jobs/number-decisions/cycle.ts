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
  /**
   * Commit identity. Passed per-command as `git -c user.name=…`, never written into the checkout's
   * config: the grounding checkout is shared infrastructure this job only borrows.
   *
   * Not optional, and not defaulted. The container runs as root with no git identity, so an absent
   * value is not "use a sensible default", it is a commit that fails after the rename has already
   * been applied — which is exactly what happened on the first live run (2026-08-22).
   */
  botName: string;
  botEmail: string;
  /**
   * `git -c` args for commands that hit the network — the write token as an Authorization header,
   * plus the proxy. Supplied by the caller so the token never reaches this module, which is the
   * one that builds log lines and PR bodies.
   */
  gitNetworkArgs: string[];
  /** The branch the checkout must be returned to. */
  baseBranch: string;
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
  // The grounding checkout is a `--depth 1` clone, so in production `git log` usually reaches none
  // of these commits and every file is undatable. That is not a failure — the id tie-break below
  // still gives a deterministic order — but it does mean the result is alphabetical rather than
  // chronological, so say so out loud rather than quietly claiming merge order.
  if (dated.every((x) => x.ts === Number.MAX_SAFE_INTEGER) && dated.length > 1) {
    logger.warn(
      { count: dated.length },
      'numbering: no inbox file could be dated from git history (shallow clone?) — falling back to id order',
    );
  }
  // Tie-break on id so two decisions in one commit — which happens, a grill can settle two things —
  // get a stable order rather than whatever Promise.all happened to produce.
  return dated.sort((a, b) => a.ts - b.ts || a.d.id.localeCompare(b.d.id)).map((x) => x.d);
}


/**
 * Put the grounding checkout back the way we found it: clean, on the base branch, with the cycle's
 * branch gone.
 *
 * **This is not tidiness, it is the difference between one failed cycle and a wedged worker.** The
 * checkout is shared infrastructure — `pullLatest` refreshes it every few minutes and every agent
 * job grounds against it. A failure part-way through leaves it dirty AND on a `numbering/` branch,
 * so the next `git pull` fails and every later run reads a tree that is neither `main` nor anything
 * anyone intended. That is the PD-340 failure mode (a dirty WIP tree poisoning the next run),
 * arrived at from a different direction.
 *
 * Observed for real on the first live run (2026-08-22): the commit failed for want of a git
 * identity, and the checkout was left with 36 staged changes on `numbering/2026-08-22-d-080`.
 *
 * Best-effort by design — every step swallows its own error. Restoration runs on the failure path,
 * and a throw here would replace the real error with a confusing one.
 */
async function restoreCheckout(config: CycleConfig, deps: CycleDeps, branch: string | null): Promise<void> {
  const cwd = config.repoRoot;
  const quietly = async (args: string[]) => {
    try {
      await deps.run('git', args, { cwd });
    } catch (err) {
      logger.warn({ err, args }, 'numbering: checkout restore step failed');
    }
  };
  await quietly(['reset', '--hard']);
  await quietly(['clean', '-fd']);
  await quietly(['checkout', config.baseBranch]);
  if (branch !== null) await quietly(['branch', '-D', branch]);
}

/** `verify`'s conclusion on the cycle's own PR: `pass`, `fail`, or `pending`. */
/**
 * The one check that gates the merge.
 *
 * **Only `verify`.** A citation rename touches whatever files happen to cite a decision, and some of
 * those are sensitive paths — the third live run rewrote a `D-TMP-` reference inside
 * `apps/server/src/widgets/task-monitor/schema.ts`, which the denylist matches with a `schema.ts` glob. The bot is not on
 * `AUTHORS_EXEMPT`, so path-guard goes red, correctly and every time.
 *
 * D-078 decided this case in advance: `--admin` exists to bypass the approval requirement *and*
 * path-guard's label ask, because a mechanical rename is not a semantic change to a sensitive file.
 * It never bypasses a red `verify`, which is why the gate is an allowlist of one rather than
 * "ignore the checks that are inconvenient".
 */
export const MERGE_GATE_CHECK = 'verify';

/** One row of `gh pr checks` output: name, then a status word. */
function checkRows(stdout: string): { name: string; state: string }[] {
  return stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && parts[0])
    .map((parts) => ({ name: parts[0], state: parts[1] }));
}

/**
 * Text of a failed command, wherever the runner put it.
 *
 * `gh pr checks` exits NON-ZERO whenever any check is failing OR pending OR absent, so a throw from
 * it is the normal case rather than the exceptional one. The runner returns stdout when there is
 * any, and otherwise rethrows a redacted message — and "no checks reported" goes to **stderr**, so
 * the empty-stdout path is the one that carries it.
 */
function failureText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Whether the PR is still open.
 *
 * A PR closed by a human while the cycle was polling reports **no checks**, which is
 * indistinguishable from "opened one second ago" by the check output alone. Without this the cycle
 * reads that as pending and spins until `ciTimeoutMs` — two hours of holding nothing, then a
 * notification that says the checks never finished, which is not what happened. Steve closed #361
 * mid-poll and got exactly that.
 */
async function prIsOpen(deps: CycleDeps, config: CycleConfig, prNumber: number): Promise<boolean> {
  try {
    const { stdout } = await deps.run(
      'gh',
      ['pr', 'view', String(prNumber), '--repo', config.githubRepo, '--json', 'state', '--jq', '.state'],
      { cwd: config.repoRoot },
    );
    // Only an EXPLICIT terminal state counts as gone. Anything else — empty output, an unrecognised
    // word, a shape change in `gh` — is uninformative, and uninformative must not be read as
    // "closed": that would abandon a healthy PR on a blip. The deadline is the backstop.
    const state = stdout.trim().toUpperCase();
    return state !== 'CLOSED' && state !== 'MERGED';
  } catch {
    return true;
  }
}

/**
 * The number of an already-open numbering PR, or null.
 *
 * Deliberately looks for the cycle's own branch prefix rather than its author: the bot account also
 * opens Robot PRs, and closing in on "a numbering PR" by branch is what makes this safe to act on.
 *
 * Returns null on any error — an unreadable list must not stop the cycle running. The worst case is
 * the behaviour that existed before this check.
 */
async function openNumberingPr(deps: CycleDeps, config: CycleConfig): Promise<number | null> {
  try {
    const { stdout } = await deps.run(
      'gh',
      ['pr', 'list', '--repo', config.githubRepo, '--state', 'open', '--json', 'number,headRefName'],
      { cwd: config.repoRoot },
    );
    const rows = JSON.parse(stdout) as { number: number; headRefName: string }[];
    const hit = rows.find((r) => r.headRefName.startsWith('numbering/'));
    return hit ? hit.number : null;
  } catch {
    return null;
  }
}

async function ciState(deps: CycleDeps, config: CycleConfig, prNumber: number): Promise<'pass' | 'fail' | 'pending'> {
  let stdout: string;
  try {
    ({ stdout } = await deps.run('gh', ['pr', 'checks', String(prNumber), '--repo', config.githubRepo], {
      cwd: config.repoRoot,
    }));
  } catch (err) {
    // Routine, not exceptional — see failureText. The exit code carries no information the text
    // does not, so the text is what gets parsed either way.
    stdout = failureText(err);
  }

  // GitHub has not registered any check runs yet — normal for the first seconds after a PR opens,
  // and it is what killed the third live run. It means "too early to tell", not "failed".
  if (/no checks reported/i.test(stdout)) return 'pending';

  const rows = checkRows(stdout);
  const gate = rows.find((r) => r.name === MERGE_GATE_CHECK);
  if (!gate) return 'pending'; // the gate itself has not appeared yet

  // Report the others without acting on them, so a red path-guard is visible in the log rather than
  // silently ignored.
  const others = rows.filter((r) => r.name !== MERGE_GATE_CHECK && /fail/i.test(r.state));
  if (others.length > 0) {
    logger.info(
      { prNumber, failing: others.map((r) => r.name) },
      'numbering: non-gating check(s) red — expected for a mechanical rename, --admin covers them (D-078)',
    );
  }

  if (/fail/i.test(gate.state)) return 'fail';
  if (/pending|queued|in_progress/i.test(gate.state)) return 'pending';
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

  // From here on the tree gets mutated, so every exit path must restore it. `branch` is tracked so
  // the restore can delete it — it is null until the checkout actually succeeds.
  let branch: string | null = null;
  try {
    const ordered = await inMergeOrder(provisional, deps, config.repoRoot);
    const assignments = assignNumbers(loadDecisions(config.repoRoot), ordered);
    const result = applyAssignments(config.repoRoot, assignments);

    // Regenerate the committed index over the post-rename tree. The inbox is empty now, so every
    // entry lands in the numbered list. This is the ONE place the committed index legitimately
    // changes (PD-551) — authoring never touches it, so there is never a second writer.
    writeFileSync(
      path.join(config.repoRoot, DECISIONS_INDEX),
      renderDecisionsIndex(loadDecisions(config.repoRoot)),
      'utf8',
    );

    if (result.dangling.length > 0) {
      // Left as-is, deliberately — see D-081. A citation with no decision behind it is
      // usually a PR that was open across a previous cycle, and inventing a target would bury it.
      notifyLoop(
        db,
        'agent_needs_human',
        'Decision numbering found citations with no decision behind them',
        `${result.dangling.join(', ')} — cited in the repo but absent from the inbox. Left unchanged; fix by hand.`,
        deps.now(),
      );
    }

    // One numbering PR at a time. The branch name is date-stamped, so a cycle that fails CI leaves
    // its PR open and the NEXT day's run opens a second one against the same inbox — same title,
    // same assignments, same red verify. Three had piled up before this was noticed (#361, #362,
    // #366). A second PR also cannot fix the first: whatever made verify red is still there.
    const existing = await openNumberingPr(deps, config);
    if (existing !== null) {
      logger.warn({ prNumber: existing }, 'numbering: a numbering PR is already open — not opening another');
      return { status: 'ci-red', prNumber: existing, assignments };
    }

    const branchName = `numbering/${new Date(deps.now()).toISOString().slice(0, 10)}-${assignments[0].id.toLowerCase()}`;
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
    await deps.run('git', ['checkout', '-b', branchName], { cwd });
    branch = branchName;
    await deps.run('git', ['add', '--', 'DECISIONS', DECISIONS_INDEX, ...result.rewritten], { cwd });
    // Identity passed per-command rather than written into the checkout's config: this job is a
    // borrower of shared infrastructure and should leave no trace in it. The container runs as root
    // with no identity of its own, so without these the commit fails — after the rename has landed.
    await deps.run(
      'git',
      ['-c', `user.name=${config.botName}`, '-c', `user.email=${config.botEmail}`, 'commit', '-m', title],
      { cwd },
    );
    await deps.run('git', [...config.gitNetworkArgs, 'push', '-u', 'origin', branchName], { cwd });
    const { stdout: prOut } = await deps.run(
      'gh',
      ['pr', 'create', '--repo', config.githubRepo, '--title', title, '--body', body, '--head', branchName],
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
      // Pending with the PR gone is not pending. Checked only on the pending path, so the healthy
      // case costs no extra API call.
      if (!(await prIsOpen(deps, config, prNumber))) {
        logger.warn({ prNumber }, 'numbering: the PR was closed or merged out from under the cycle — stopping');
        notifyLoop(
          db,
          'agent_needs_human',
          `Decision numbering PR #${prNumber} is no longer open`,
          'The cycle was waiting on its checks when the PR was closed or merged by someone else. Nothing was merged by the cycle; decisions stay provisional until a numbering PR lands.',
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
  } finally {
    // Always restore the shared checkout. On success the work is merged and the local branch is
    // spent; on any other path the tree is half-rewritten and MUST NOT be left for the next job to
    // ground against. Either way the checkout goes back to a clean base branch.
    await restoreCheckout(config, deps, branch);
  }
}
