import type Database from 'better-sqlite3';
import { VISUAL_CAPTURE_ENABLED_KEY, VISUAL_CAPTURE_ENV } from '@dashboard/shared';
import type { AgentWorkerConfig } from '../../shared/config';
import { writeState } from '../robot/state';
import { touchesWeb } from './routes';

/**
 * What a Robot PR says about its screenshots (PD-793), and the worker's capture heartbeat (PD-794).
 *
 * Every evaluated head gets exactly one `visual_captures` row, and with it one PR comment naming one
 * of four states: captured (the capture pass's own comment, with links), capture off, capture failed,
 * or no UI change. A PR never stays silent about screenshots.
 *
 * The row is also what the dashboard reads to show the real capture state on the Decisions card.
 */

export type Commenter = (repo: string, prNumber: number, body: string) => Promise<void>;

export function ensureVisualCapturesTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS visual_captures (
      id          INTEGER PRIMARY KEY,
      ticket_id   INTEGER NOT NULL,
      pr_number   INTEGER NOT NULL,
      head_sha    TEXT    NOT NULL,
      outcome     TEXT    NOT NULL,
      detail      TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_visual_captures_pr ON visual_captures (pr_number, head_sha);
  `);
}

/** Outcomes that settle a head for good. An `off` row does not: if capture is switched on later,
 *  the capture pass still photographs that head. */
const SETTLED = ['captured', 'failed', 'skipped'];

/** Whether this head already has a row of one of `outcomes` (default: any). */
export function headRecorded(db: Database.Database, prNumber: number, headSha: string, outcomes?: readonly string[]): boolean {
  const rows = db.prepare('SELECT outcome FROM visual_captures WHERE pr_number = ? AND head_sha = ?').all(prNumber, headSha) as {
    outcome: string;
  }[];
  return rows.some((r) => !outcomes || outcomes.includes(r.outcome));
}

/** Whether the capture pass has settled this head (captured, failed, or skipped). */
export function headSettled(db: Database.Database, prNumber: number, headSha: string): boolean {
  return headRecorded(db, prNumber, headSha, SETTLED);
}

export function recordCapture(
  db: Database.Database,
  row: { ticketId: number; prNumber: number; headSha: string; outcome: string; detail: string | null },
  now: number,
): void {
  db.prepare('INSERT INTO visual_captures (ticket_id, pr_number, head_sha, outcome, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    row.ticketId, row.prNumber, row.headSha, row.outcome, row.detail, now,
  );
}

const short = (sha: string) => sha.slice(0, 7);
export const STATUS_MARKER = '<!-- visual:status -->';

export function captureOffComment(headSha: string, requested: boolean): string {
  return [
    STATUS_MARKER,
    `**Visual: capture is off.** Screenshots not taken for ${short(headSha)}: \`${VISUAL_CAPTURE_ENV}\` is not set on the worker.`,
    ...(requested ? ['', 'A visual check was asked for. It was skipped, so this PR is not held for it.'] : []),
  ].join('\n');
}

export function captureFailedComment(headSha: string, reason: string): string {
  const r = reason.trim().slice(0, 600) || 'no reason recorded';
  return [STATUS_MARKER, `**Visual: capture failed** for ${short(headSha)}.`, '', '```', r, '```'].join('\n');
}

export function noUiChangeComment(headSha: string): string {
  return [STATUS_MARKER, `**Visual: no UI change.** ${short(headSha)} touches nothing in the web app, so no screenshots were taken.`].join('\n');
}

/** Paths touched by a unified diff (`diff --git a/x b/x`). */
export function diffPaths(diff: string): string[] {
  const out: string[] = [];
  for (const m of diff.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)) out.push(m[2]);
  return out;
}

/**
 * With capture switched off, say so on the PR, once per head. A head that touches the web app, or
 * that someone asked to see, is "capture is off"; anything else is "no UI change". `diff` null means
 * not known (a PR the gate held before this existed), which reads as "capture is off".
 */
export async function recordCaptureOff(
  db: Database.Database,
  target: { ticketId: number; repo: string; prNumber: number },
  headSha: string,
  opts: { diff: string | null; requested: boolean; comment: Commenter },
  now: number,
): Promise<void> {
  ensureVisualCapturesTable(db);
  if (headRecorded(db, target.prNumber, headSha)) return;
  const uiChange = opts.requested || opts.diff === null || touchesWeb(diffPaths(opts.diff));
  if (uiChange) {
    recordCapture(db, { ...target, headSha, outcome: 'off', detail: `${VISUAL_CAPTURE_ENV} unset` }, now);
    await opts.comment(target.repo, target.prNumber, captureOffComment(headSha, opts.requested));
  } else {
    recordCapture(db, { ...target, headSha, outcome: 'skipped', detail: 'no web changes' }, now);
    await opts.comment(target.repo, target.prNumber, noUiChangeComment(headSha));
  }
}

/** The worker's capture heartbeat: whether capture is on, written every tick so the dashboard can
 *  tell "off" from "on and queued" from "worker not reporting". */
export function recordCaptureHeartbeat(db: Database.Database, config: AgentWorkerConfig, now: number): void {
  writeState(db, VISUAL_CAPTURE_ENABLED_KEY, config.visual.enabled ? '1' : '0', now);
}

/** robot_state key holding the review boundary whose capture-off ship already posted review-gate
 *  success, so the release pass does not post it again. */
export const captureOffReleaseKey = (ticketId: number): string => `visual_capture_off_released:${ticketId}`;
