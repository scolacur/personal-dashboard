import { logger } from '../../shared/logger';
import { ABORT_SHUTDOWN, type RunOwnership } from './ownership';

/** Resolve to `fallback` after `ms`. Used with `Promise.race` to time-box a possibly-hung async step
 *  (a WIP `git push`) against the container's stop-grace window (PD-784/D-104). The timer is
 *  `unref`'d so a pending one never keeps the process alive on its own. */
export function timeout<T>(ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    if (typeof t === 'object' && typeof (t as { unref?: () => void }).unref === 'function') {
      (t as { unref: () => void }).unref();
    }
  });
}

/**
 * Graceful-stop coordinator for the Robot loop (PD-784, D-104).
 *
 * Without this, a deploy's SIGTERM → SIGKILL killed the worker mid-run: the in-flight `agent_runs`
 * rows were left `running`, their tickets `working`, and PD-736's WIP push — which runs in a
 * `finally` the killed process never reaches — never fired, losing the work. The boot sweep then
 * had to reclaim the debris on the NEXT start.
 *
 * On SIGTERM this flips `requested` (so the loop dispatches nothing new) and aborts every in-flight
 * session. Each aborted session unwinds through the loop's normal failure path (robot.ts), which —
 * recognising the stop — closes the run as a transient `interrupted` fault (D-104: re-queued, never
 * counted), after attempting a time-boxed WIP push. A graceful stop therefore leaves nothing
 * `running`, so the next boot's ownership sweep finds no orphan and never dispatches the ticket
 * twice.
 */
export class RobotShutdown {
  private _requested = false;

  constructor(private readonly ownership: RunOwnership) {}

  /** Has a graceful stop begun? The loop checks this to refuse new dispatch. */
  get requested(): boolean {
    return this._requested;
  }

  /** Begin a graceful stop: refuse new dispatch and abort every in-flight session. Idempotent, so
   *  a repeated signal (SIGTERM then SIGINT) is a no-op. */
  request(): void {
    if (this._requested) return;
    this._requested = true;
    const inFlight = this.ownership.inFlight();
    logger.warn({ inFlight: inFlight.length }, 'robot: graceful stop requested — aborting in-flight sessions');
    for (const run of inFlight) {
      try {
        run.abort.abort(ABORT_SHUTDOWN);
      } catch (err) {
        logger.warn({ err, ticketId: run.ticketId }, 'robot: aborting in-flight session raised — ignored');
      }
    }
  }
}
