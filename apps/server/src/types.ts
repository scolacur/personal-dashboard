import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { CronLogger, CronRegistry } from './cron';

export interface BackendWidget {
  name: string;
  registerRoutes(app: FastifyInstance): void;
  bootstrapSchema?(db: Database.Database): void;
  /** Register scheduled jobs. `log` is the app's pino logger for job diagnostics. */
  registerCron?(cron: CronRegistry, log: CronLogger): void;
}
