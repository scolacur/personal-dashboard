import type { BackendWidget } from '../../types';
import { db } from '../../db';
import { bootstrapSchema } from './schema';
import { seedIfEmpty } from './seed/seed-if-empty';
import { registerRoutes } from './routes';
import { registerAuditJob } from './audit-cron';

export const widget: BackendWidget = {
  name: 'task-monitor',
  bootstrapSchema(database) {
    bootstrapSchema(database);
    seedIfEmpty(database);
  },
  registerRoutes(app) {
    registerRoutes(app, db);
  },
  registerCron(cron, log) {
    // PD-283 (D-045): weekly Ticket Audit — enqueue a run the agent-worker executes.
    registerAuditJob(cron, log, db);
  },
};
