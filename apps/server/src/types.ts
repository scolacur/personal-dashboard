import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { CronRegistry } from './cron';

export interface BackendWidget {
  name: string;
  registerRoutes(app: FastifyInstance): void;
  bootstrapSchema?(db: Database.Database): void;
  registerCron?(cron: CronRegistry): void;
}
