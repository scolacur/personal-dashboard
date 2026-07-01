import type { BackendWidget } from '../../types';
import { db } from '../../db';
import { bootstrapSchema } from './schema';
import { seedIfEmpty } from './seed/seed-if-empty';
import { registerRoutes } from './routes';

export const widget: BackendWidget = {
  name: 'agent-dashboard',
  bootstrapSchema(database) {
    bootstrapSchema(database);
    seedIfEmpty(database);
  },
  registerRoutes(app) {
    registerRoutes(app, db);
  },
};
