import type { BackendWidget } from '../../types';
import { db } from '../../db';
import { bootstrapSchema } from './schema';
import { registerRoutes } from './routes';
import { registerIdTrackerJobs } from './sync';

export const widget: BackendWidget = {
  name: 'id-tracker',
  bootstrapSchema(database) {
    bootstrapSchema(database);
  },
  registerRoutes(app) {
    registerRoutes(app, db, app.log);
  },
  registerCron(cron, log) {
    registerIdTrackerJobs(cron, log, db);
  },
};
