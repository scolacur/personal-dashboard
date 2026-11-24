import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { NavPagePatch } from '@dashboard/shared';
import { getNavPages, patchNavPage, type PatchError } from './shell-pages';

/**
 * Nav page endpoints (PD-969 — pages become data). Shell routes, mounted beside
 * `/api/shell/pages/...widgets` (shell-layout-routes.ts). Kept under a distinct `nav-pages` base so
 * they cannot collide with the `/api/shell/pages/:pageId/widgets` param route.
 */

const STATUS: Record<PatchError, number> = {
  NOT_FOUND: 404,
  PARENT_NOT_FOUND: 400,
  CYCLE: 400,
  PINNED: 400,
  INVALID_TITLE: 400,
};

function parsePatch(raw: unknown): NavPagePatch | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const out: NavPagePatch = {};
  if ('title' in o) {
    if (typeof o.title !== 'string') return null;
    out.title = o.title;
  }
  if ('parentId' in o) {
    if (o.parentId !== null && typeof o.parentId !== 'string') return null;
    out.parentId = o.parentId as string | null;
  }
  if ('order' in o) {
    if (typeof o.order !== 'number' || !Number.isFinite(o.order) || o.order < 0) return null;
    out.order = Math.floor(o.order);
  }
  if (Object.keys(out).length === 0) return null;
  return out;
}

export function registerShellPagesRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/shell/nav-pages', async () => getNavPages(db));

  // Returns the whole list after the change: a move renumbers siblings in two groups, and the
  // client simply replaces its copy rather than reconstructing that.
  app.patch<{ Params: { id: string }; Body: unknown }>(
    '/api/shell/nav-pages/:id',
    async (req, reply) => {
      const patch = parsePatch(req.body);
      if (!patch)
        return reply.status(400).send({ error: 'invalid patch body', code: 'INVALID_BODY' });

      const result = patchNavPage(db, req.params.id, patch);
      if ('error' in result) {
        return reply.status(STATUS[result.error]).send({ error: result.error, code: result.error });
      }
      return result.pages;
    },
  );
}
