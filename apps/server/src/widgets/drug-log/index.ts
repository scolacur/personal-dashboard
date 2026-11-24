import type { BackendWidget } from '../../types';
import { db } from '../../db';
import { bootstrapSchema } from './schema';
import { registerRoutes } from './routes';

export const widget: BackendWidget = {
  name: 'drug-log',
  bootstrapSchema(database) {
    bootstrapSchema(database);
  },
  registerRoutes(app) {
    registerRoutes(app, db);
  },
};
