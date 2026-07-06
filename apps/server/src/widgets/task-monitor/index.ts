import type { BackendWidget } from '../../types';
import { db } from '../../db';
import { bootstrapSchema } from './schema';
import { seedIfEmpty } from './seed/seed-if-empty';
import { registerRoutes } from './routes';
import { registerGithubSyncJob } from './github-sync';

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
    // PD-165: poll GitHub `sortie:*` labels → derived status + agent state.
    registerGithubSyncJob(cron, log, db);
  },
};
