import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentWorkerConfig } from '../../shared/config';
import { logger } from '../../shared/logger';
import type { PrFetcher, PrState } from './pr-state';
import { asOwnerOf, makeGitRunner, type Worktree } from './workspace';

/**
 * In-flight rework supersession (PD-926).
 *
 * PD-924 (rework-guard.ts) checks a rework's PR once, at dispatch. A PR can also change while the
 * rework RUNS: on 2026-11-23 PD-761's PR merged four minutes into a rework that then ran to its
 * 51-turn ceiling. Every turn after the merge was spent on work that could never land.
 *
 * So while a rework runs, the loop checks its PR every `config.robot.supersedeCheckMs` and stops
 * the session when:
 *  - the PR MERGED or CLOSED, or
 *  - its head moved to a commit the Robot's clone doesn't have. The Robot's own pushes are in its
 *    clone, so a missing commit means someone else pushed, and the requested changes may no longer
 *    describe the code.
 *
 * It never stops a session once `.robot/verify-ok` exists: a green verify is a hand-off in progress,
 * and stopping it would lose finished work (D-046).
 */
export type SupersedeKind = 'merged' | 'closed' | 'pushed';
export interface Supersession {
  kind: SupersedeKind;
  prNumber: number;
  reason: string;
}

/** Pure: does this PR reading supersede the rework? `baseline` is the head it started from (null when
 *  unknown — then a moved head can't be judged, only a terminal state). */
export async function supersessionFor(
  pr: PrState,
  prNumber: number,
  baseline: string | null,
  hasCommit: (sha: string) => Promise<boolean>,
): Promise<Supersession | null> {
  if (pr.state === 'MERGED') return { kind: 'merged', prNumber, reason: `PR #${prNumber} merged while the rework was running` };
  if (pr.state === 'CLOSED') {
    return { kind: 'closed', prNumber, reason: `PR #${prNumber} was closed without merging while the rework was running` };
  }
  const head = pr.headRefOid;
  if (!head || !baseline || head === baseline) return null;
  if (await hasCommit(head)) return null; // the Robot's own push (or a commit it already fetched)
  return {
    kind: 'pushed',
    prNumber,
    reason: `PR #${prNumber} was pushed to by someone else while the rework was running (${baseline.slice(0, 7)} → ${head.slice(0, 7)})`,
  };
}

export interface SupersedeWatchInput {
  repo: string;
  prNumber: number;
  /** The PR head when the rework was dispatched; null if the dispatch-time fetch failed. */
  baseline: string | null;
  intervalMs: number;
  fetchPr: PrFetcher;
  hasCommit: (sha: string) => Promise<boolean>;
  /** True once the session has reached a green verify — from then on it is never stopped. */
  handoffStarted: () => boolean;
  onSupersede: (s: Supersession) => void;
}

/** Start polling. Returns a stop function; safe to call more than once. Never throws. */
export function watchForSupersession(input: SupersedeWatchInput): () => void {
  let baseline = input.baseline;
  let busy = false;
  let done = false;
  const timer = setInterval(() => {
    if (busy || done) return;
    busy = true;
    void (async () => {
      try {
        if (input.handoffStarted()) return;
        const pr = await input.fetchPr(input.repo, input.prNumber);
        if (!pr || done) return;
        // Adopt the first head we see when dispatch couldn't read one, so a later move is judged.
        if (baseline === null && pr.headRefOid && pr.state === 'OPEN') {
          baseline = pr.headRefOid;
          return;
        }
        const s = await supersessionFor(pr, input.prNumber, baseline, input.hasCommit);
        if (s && !done && !input.handoffStarted()) {
          done = true;
          clearInterval(timer);
          input.onSupersede(s);
        } else if (!s && pr.headRefOid) {
          baseline = pr.headRefOid; // the Robot pushed: its new head is the new baseline
        }
      } catch (err) {
        logger.warn({ err, prNumber: input.prNumber }, 'robot: supersession check failed — will retry');
      } finally {
        busy = false;
      }
    })();
  }, input.intervalMs);
  return () => {
    done = true;
    clearInterval(timer);
  };
}

/** Default: is `sha` a commit in this clone? Missing object (or any git failure) ⇒ false. */
export function defaultHasCommit(config: AgentWorkerConfig): (wt: Worktree, sha: string) => Promise<boolean> {
  const git = makeGitRunner(config, config.robot.writeToken);
  return async (wt, sha) => {
    try {
      await git([...asOwnerOf(wt.dir), 'cat-file', '-e', `${sha}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  };
}

/** Default: the D-046 green-verify marker exists in the clone. */
export function defaultHandoffStarted(wt: Worktree): boolean {
  return existsSync(join(wt.dir, '.robot', 'verify-ok'));
}
