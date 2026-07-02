import cron, { type ScheduledTask } from 'node-cron';

/** Minimal logger surface — satisfied by Fastify's `app.log` (pino). */
export interface CronLogger {
  info(msg: string): void;
  error(msg: string): void;
}

/**
 * In-process scheduler shared by the server and its widgets.
 *
 * Widgets receive this via `registerCron(cron)` (see PROJECT.md §2) and register
 * named jobs; core concerns (e.g. DB backups) register directly from `index.ts`.
 * A registered task is wrapped so a throw is logged and swallowed — one job's
 * failure never crashes the process or stops the schedule. Deliberately tiny:
 * `node-cron` runs everywhere Node does, so nothing here is host-specific and it
 * ports as-is off Synology.
 */
export class CronRegistry {
  private readonly tasks = new Map<string, ScheduledTask>();

  constructor(private readonly log: CronLogger) {}

  /**
   * Schedule `task` under `name` on the cron `schedule`. Runs are logged and
   * errors are caught. Throws on an invalid schedule or a duplicate name so
   * misconfiguration surfaces at boot, not silently.
   */
  register(name: string, schedule: string, task: () => void | Promise<void>): void {
    if (!cron.validate(schedule)) {
      throw new Error(`CronRegistry: invalid schedule "${schedule}" for job "${name}"`);
    }
    if (this.tasks.has(name)) {
      throw new Error(`CronRegistry: duplicate job name "${name}"`);
    }

    const scheduled = cron.schedule(schedule, async () => {
      const started = Date.now();
      this.log.info(`cron "${name}" started`);
      try {
        await task();
        this.log.info(`cron "${name}" finished in ${Date.now() - started}ms`);
      } catch (err) {
        this.log.error(`cron "${name}" failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      }
    });

    this.tasks.set(name, scheduled);
    this.log.info(`cron "${name}" registered (${schedule})`);
  }

  /** Stop every scheduled job (used in tests / graceful shutdown). */
  stopAll(): void {
    for (const task of this.tasks.values()) task.stop();
    this.tasks.clear();
  }
}
