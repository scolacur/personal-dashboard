import type Database from 'better-sqlite3';
import { HUMAN_REPLY_MARKER, OPEN_PRS_SNAPSHOT_KEY, type OpenPrsSnapshot } from '@dashboard/shared';
import { writeState } from '../robot/state';
import type { OtherPr } from './all-prs';

/**
 * The open-PR snapshot (PD-1007): the worker's record of which PRs are open, at which head, and
 * whether Steve has approved them, written each Evaluator pass from the listing it already makes.
 *
 * The server's Escalations section needs to know a PR is still open and unapproved, and must never
 * call GitHub from a web request. Nothing in the DB says so for a session PR: a close without a merge
 * leaves no trace, and Steve's approval only exists as a GitHub review. So the worker, which reads
 * GitHub anyway, writes what it saw to `robot_state`, and the server reads that.
 */

type Review = NonNullable<OtherPr['reviews']>[number];

/**
 * Whether the PR carries a standing authorized approval. A TypeScript copy of
 * `.github/scripts/authorized-approval.sh`, which `review-gate.yml` uses to post "Approved by Steve":
 * each reviewer's latest review counts; it is an APPROVED from the repo OWNER, or from a COLLABORATOR
 * carrying `HUMAN_REPLY_MARKER`; the bot's own reviews never count.
 */
export function steveApproved(reviews: readonly Review[] | undefined, botLogin: string): boolean {
  const latest = new Map<string, Review>();
  for (const r of reviews ?? []) {
    const login = r.author?.login;
    if (!login) continue;
    const prev = latest.get(login);
    if (!prev || (r.submittedAt ?? '') >= (prev.submittedAt ?? '')) latest.set(login, r);
  }
  return [...latest.entries()].some(
    ([login, r]) =>
      r.state === 'APPROVED' &&
      login !== botLogin &&
      (r.authorAssociation === 'OWNER' ||
        (r.authorAssociation === 'COLLABORATOR' && (r.body ?? '').includes(HUMAN_REPLY_MARKER))),
  );
}

/** Write the snapshot of the open PRs just listed. */
export function recordOpenPrs(
  db: Database.Database,
  prs: readonly OtherPr[],
  opts: { botLogin: string; maxRounds: number },
  now: number = Date.now(),
): void {
  const snapshot: OpenPrsSnapshot = {
    maxRounds: opts.maxRounds,
    prs: prs.map((p) => ({ number: p.number, headSha: p.headRefOid, approved: steveApproved(p.reviews, opts.botLogin) })),
  };
  writeState(db, OPEN_PRS_SNAPSHOT_KEY, JSON.stringify(snapshot), now);
}
