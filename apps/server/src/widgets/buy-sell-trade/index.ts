import type { BackendWidget } from '../../types';
import { db } from '../../db';
import { bootstrapSchema } from './schema';
import { registerRoutes } from './routes';
import { registerBstJobs } from './jobs';

export const widget: BackendWidget = {
  name: 'buy-sell-trade',
  bootstrapSchema(database) {
    bootstrapSchema(database);
  },
  registerRoutes(app) {
    registerRoutes(app, db);
  },
  registerCron(cron, log) {
    registerBstJobs(cron, log, db);
  },
};
