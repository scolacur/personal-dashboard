import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { PageWidget } from '@dashboard/shared';
import { getAllPageWidgets, getPageWidgets, setPageWidgets } from './shell-layout';

/**
 * Page-membership endpoints for the dashboard shell (PD-334, D-071).
 *
 * Core routes rather than widget routes — the shell is not a widget — so these mount at
 * `/api/shell/...` and are registered from index.ts alongside `/api/jobs/...` (PD-442).
 */

/**
 * Validate one incoming placement.
 *
 * Strict, unlike the read surfaces' forgiving query parsing: a bad write silently reshapes the
 * user's dashboard, where a bad read just shows less. Spans are clamped rather than rejected —
 * a too-large span is a UI bug, not a reason to refuse the whole page.
 */
function parsePageWidget(raw: unknown): PageWidget | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.widgetId !== 'string' || o.widgetId.trim() === '') return null;

  const cols = Number(o.cols);
  const rows = Number(o.rows);
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;

  return {
    widgetId: o.widgetId,
    // `order` is normalised from array position by the store; whatever arrives here is ignored.
    order: 0,
    cols: Math.max(1, Math.floor(cols)),
    rows: Math.max(1, Math.floor(rows)),
  };
}

export function registerShellLayoutRoutes(app: FastifyInstance, db: Database.Database): void {
  // Every page in one response. The client loads this once at boot so `canArrange` and the grid
  // stay synchronous derivations (D-071); the payload is tens of rows.
  app.get('/api/shell/pages/widgets', async () => getAllPageWidgets(db));

  app.get<{ Params: { pageId: string } }>(
    '/api/shell/pages/:pageId/widgets',
    async (req) => getPageWidgets(db, req.params.pageId),
  );

  app.put<{ Params: { pageId: string }; Body: unknown }>(
    '/api/shell/pages/:pageId/widgets',
    async (req, reply) => {
      if (!Array.isArray(req.body)) {
        return reply
          .status(400)
          .send({ error: 'body must be an array of placements', code: 'INVALID_BODY' });
      }

      const parsed: PageWidget[] = [];
      for (const raw of req.body) {
        const w = parsePageWidget(raw);
        if (!w) {
          return reply
            .status(400)
            .send({ error: 'invalid placement in body', code: 'INVALID_PLACEMENT' });
        }
        parsed.push(w);
      }

      // An empty array is a legitimate write — it is how a page is emptied, which Home is
      // expected to be once the library ships. Not treated as a mistake.
      return setPageWidgets(db, req.params.pageId, parsed);
    },
  );
}
