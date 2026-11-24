import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { MAX_USAGE_LIMIT, listWidgetUsage, recordWidgetUse } from './widget-usage';

/**
 * Widget-usage endpoints (PD-751, Home shows recently used widgets).
 *
 * Shell routes, mounted under `/api/shell/...` beside page membership (PD-334, D-073).
 */

/**
 * Registry ids are lowercase kebab-case (`habit-tracker`, `devops-jobs`). The server cannot read
 * the registry — it lives in `apps/web` — so it checks the *shape* instead. That is enough to
 * stop junk (paths, whitespace, huge strings) from landing in the table; an id that is
 * well-formed but unregistered is filtered out by the client when Home renders.
 */
export const WIDGET_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_WIDGET_ID_LENGTH = 64;

export function isValidWidgetId(id: string): boolean {
  return id.length <= MAX_WIDGET_ID_LENGTH && WIDGET_ID_PATTERN.test(id);
}

export function registerWidgetUsageRoutes(app: FastifyInstance, db: Database.Database): void {
  // Most recent first. `limit` is forgiving, as read surfaces are here: anything unparseable
  // falls back to the ceiling rather than erroring.
  app.get<{ Querystring: { limit?: string } }>('/api/shell/widget-usage', async (req) => {
    const n = Number(req.query.limit);
    return listWidgetUsage(db, Number.isFinite(n) && n > 0 ? n : MAX_USAGE_LIMIT);
  });

  // No body: the server stamps the time, so a client's clock never reorders Home.
  app.post<{ Params: { widgetId: string } }>(
    '/api/shell/widget-usage/:widgetId',
    async (req, reply) => {
      const { widgetId } = req.params;
      if (!isValidWidgetId(widgetId)) {
        return reply.status(400).send({ error: 'invalid widget id', code: 'INVALID_WIDGET_ID' });
      }
      return recordWidgetUse(db, widgetId);
    },
  );
}
