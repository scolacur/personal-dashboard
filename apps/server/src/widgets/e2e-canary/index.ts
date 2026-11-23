import type { BackendWidget } from '../../types';
import { db } from '../../db';
import { bootstrapSchema } from './schema';
import { registerRoutes } from './routes';

/** A throwaway widget the E2E loop test builds into and resets (PD-892). */
export const widget: BackendWidget = {
  name: 'e2e-canary',
  bootstrapSchema(database) {
    bootstrapSchema(database);
  },
  registerRoutes(app) {
    registerRoutes(app, db);
  },
};
