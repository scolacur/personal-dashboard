import type { AgentWorkerConfig } from '../../shared/config';
import { logger } from '../../shared/logger';
import { asOwnerOf, GitError, makeGitRunner, type GitRunner, type Worktree } from './workspace';

/**
 * Preserve a non-hand-off run's work before its clone is dropped (PD-737/T898).
 *
 * A run that ends without a hand-off (max turns, a crash, no green verify) used to lose everything
 * it wrote: the coding session only commits during the hand-off (Finish Step 3), so a run that
 * never got there left UNCOMMITTED debris, which the next dispatch's reuse discards (`reset --hard`
 * + `clean -fd` in ensureWorktree) — and nothing pushed it anywhere a human could reach. Live loss
 * on 2026-11-16: PD-721 ran twice to the 50-turn ceiling, two turns short of a green verify both
 * times, and both trees were thrown away.
 *
 * So on every non-hand-off exit the loop commits whatever is in the clone (untracked included,
 * `.robot/` markers excluded — they are gitignored, so `add -A` never stages them) and pushes it to
 * a DEDICATED ref, `robot-wip/t<id>`:
 *  - distinct from the `robot/<id>` branch, so it is never a PR head and `robot-auto-merge.yml` /
 *    `review-gate` can never touch it, and it can't be mistaken for a hand-off;
 *  - no PR is ever opened from it;
 *  - the push failing must NEVER fail or mask the run's real outcome — it is caught, logged, and
 *    treated as "nothing preserved".
 *
 * **Preserve only, no resume (D-094).** Nothing here makes the next dispatch start from the WIP ref;
 * PD-340's pristine-tree default stands. The ref exists for a human to `git fetch`, and for PD-737's
 * human-chosen Continue to read — not for automatic resume, which would let a broken WIP poison every
 * retry.
 */

/** The dedicated scratch ref a non-hand-off run's work is pushed to. */
export function wipRefName(ticketId: number): string {
  return `robot-wip/t${ticketId}`;
}

export interface WipRef {
  /** The ref the work was pushed to, e.g. `robot-wip/t898`. */
  ref: string;
  /** The commit sha at the tip of that ref. */
  sha: string;
}

const WIP_COMMIT_PREFIX = 'chore(robot): WIP';

/** Commit staged changes if there are any; returns whether a commit was made. A clean index (nothing
 *  staged) returns false. `--no-verify` because this is scratch — a repo hook must not block it. */
async function commitIfStaged(git: GitRunner, owner: string[], ticketId: number): Promise<boolean> {
  try {
    // `diff --cached --quiet` exits 0 when the index matches HEAD (nothing staged), 1 when it differs.
    await git([...owner, 'diff', '--cached', '--quiet']);
    return false;
  } catch (err) {
    if (err instanceof GitError && err.exitCode === 1) {
      await git([...owner, 'commit', '--no-verify', '-m', `${WIP_COMMIT_PREFIX}: ticket ${ticketId} (no hand-off)`]);
      return true;
    }
    throw err; // a real git failure, not "there are staged differences"
  }
}

/** Whether HEAD has diverged from `origin/main` — the cheap proxy for "this clone holds work worth
 *  preserving" when no new commit was made (a reused clone whose earlier run committed but parked).
 *  Any failure reads as "can't tell", so we only push on a commit we actually made. */
async function headDiffersFromMain(git: GitRunner, owner: string[]): Promise<boolean> {
  try {
    const head = (await git([...owner, 'rev-parse', 'HEAD']))?.toString().trim();
    const main = (await git([...owner, 'rev-parse', 'origin/main']))?.toString().trim();
    return !!head && !!main && head !== main;
  } catch {
    return false;
  }
}

/**
 * Commit + push a non-hand-off run's WIP to `robot-wip/t<id>`. Returns the ref + sha pushed, or null
 * when there was nothing worth preserving or the push failed (NEVER throws — see the module header).
 * Run by the loop (root) against the coding-uid-owned clone, hence `asOwnerOf`.
 */
export async function pushWip(
  config: AgentWorkerConfig,
  worktree: Worktree,
  ticketId: number,
  git: GitRunner = makeGitRunner(config, config.robot.writeToken),
): Promise<WipRef | null> {
  const dir = worktree.dir;
  const ref = wipRefName(ticketId);
  const owner = asOwnerOf(dir);
  try {
    // `.robot/` is gitignored, so `add -A` stages everything the run produced EXCEPT the hand-off
    // markers — exactly what we want excluded.
    await git([...owner, 'add', '-A']);
    const committed = await commitIfStaged(git, owner, ticketId);
    // Nothing to preserve: no new commit and the branch is still `main`. Skip the push so a run that
    // did nothing doesn't litter a ref pointing straight at main.
    if (!committed && !(await headDiffersFromMain(git, owner))) return null;
    const sha = (await git([...owner, 'rev-parse', 'HEAD']))?.toString().trim();
    if (!sha) return null;
    // Force because the ref is scratch, overwritten on each non-hand-off run of this ticket.
    await git([...owner, 'push', '--force', 'origin', `HEAD:refs/heads/${ref}`]);
    logger.info({ ticketId, ref, sha }, 'robot: pushed WIP of a non-hand-off run — `git fetch` it to inspect/continue');
    return { ref, sha };
  } catch (err) {
    // Hard rule: a failed WIP push must not change the run's recorded outcome. Log and move on.
    logger.warn({ err, ticketId, ref }, 'robot: WIP push failed — the run outcome is unaffected');
    return null;
  }
}

/**
 * Delete the WIP ref (best-effort, never throws). Called when the ticket hands off a PR — its work
 * is on GitHub, so the WIP ref is superseded — and again when it goes terminal, so scratch refs
 * don't pile up. `cwd` is any clone with `origin` configured (the worktree at hand-off, else the
 * grounding checkout). The common outcome is "remote ref does not exist" (the run never pushed WIP),
 * which is fine and logged at debug.
 */
export async function deleteWipRef(
  config: AgentWorkerConfig,
  ticketId: number,
  cwd: string,
  git: GitRunner = makeGitRunner(config, config.robot.writeToken),
): Promise<void> {
  const ref = wipRefName(ticketId);
  try {
    await git([...asOwnerOf(cwd), 'push', 'origin', '--delete', `refs/heads/${ref}`]);
    logger.info({ ticketId, ref }, 'robot: deleted the WIP ref (ticket handed off / terminal)');
  } catch (err) {
    logger.debug({ err, ticketId, ref }, 'robot: WIP ref delete was a no-op or failed (ignored)');
  }
}
