import type { BackendWidget } from '../../types';
import { db } from '../../db';
import { bootstrapSchema } from './schema';
import { registerRoutes } from './routes';
import { registerBstJobs } from './jobs';
import { purgeIgnoredAuthorMatches } from './store';

export const widget: BackendWidget = {
  name: 'buy-sell-trade',
  bootstrapSchema(database) {
    bootstrapSchema(database);
    // Sweeps matches from ignored authors (Steve's own account) — see the function's note on why
    // this runs every boot instead of once as a migration.
    purgeIgnoredAuthorMatches(database);
  },
  registerRoutes(app) {
    registerRoutes(app, db);
  },
  registerCron(cron, log) {
    registerBstJobs(cron, log, db);
  },
};
