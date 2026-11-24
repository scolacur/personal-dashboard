import type { AgentRun, ProgressVerdict, RobotEventDetail, TicketEvent } from '@dashboard/shared';
import { ROBOT_EVENT, progressCheckLine } from '@dashboard/shared';

/** PD-964 (D-114): one progress check, as the run history shows it. */
export interface RunProgressCheck {
  at: number;
  verdict: ProgressVerdict;
  /** Did the run carry on after it? */
  passed: boolean;
  line: string;
}

/**
 * The `robot_progress_check` events that fall inside `run` (from its start to its finish, or to now
 * while it is running), oldest first. Runs on one ticket never overlap — the loop dispatches a ticket
 * once at a time — so the time span alone places each check. Pure.
 */
export function progressChecksForRun(run: AgentRun, events: readonly TicketEvent[], now: number = Date.now()): RunProgressCheck[] {
  const end = run.finishedAt ?? now;
  return events
    .filter((e) => e.type === ROBOT_EVENT.progressCheck && e.createdAt >= run.startedAt && e.createdAt <= end)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((e) => {
      const d = (e.detail ?? {}) as RobotEventDetail;
      const verdict = d.progress ?? 'error';
      return {
        at: e.createdAt,
        verdict,
        passed: verdict === 'progressing' && d.checkedBy !== 'total_cap',
        line: progressCheckLine(d),
      };
    });
}
