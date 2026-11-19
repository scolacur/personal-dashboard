import type { FastifyInstance, FastifyReply } from 'fastify';
import type Database from 'better-sqlite3';
import {
  archiveItem,
  createItem,
  deleteItem,
  getCompletions,
  getSettings,
  getTodayView,
  HabitValidationError,
  listAllSchedules,
  listItems,
  moveItem,
  patchSettings,
  renameItem,
  reorderItems,
  setCompletion,
  setSchedule,
} from './habits';

/**
 * HTTP surface for the shared habit store (PD-721, D-092).
 *
 * Core routes, not widget routes — the store is shared infrastructure (D-092), so these mount at
 * `/api/habits/...` and are registered from index.ts alongside the job-run and shell-layout routes,
 * not from inside the Habit Tracker widget folder.
 */

const BASE = '/api/habits';

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function sendValidation(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof HabitValidationError) return reply.code(400).send({ error: e.message, code: e.code });
  throw e;
}

export function registerHabitRoutes(app: FastifyInstance, db: Database.Database): void {
  /* ── Items ────────────────────────────────── */

  app.get(`${BASE}/items`, async (request) => {
    const q = request.query as { includeArchived?: string };
    const includeArchived = q.includeArchived === '1' || q.includeArchived === 'true';
    return { items: listItems(db, { includeArchived }) };
  });

  app.post(`${BASE}/items`, async (request, reply) => {
    try {
      return reply.code(201).send(createItem(db, (request.body ?? {}) as { name?: unknown }));
    } catch (e) {
      return sendValidation(reply, e);
    }
  });

  /** Reorder is a collection route, so it sits before `:id` to avoid being shadowed by it. */
  app.put(`${BASE}/items/reorder`, async (request, reply) => {
    const body = (request.body ?? {}) as { ids?: unknown };
    try {
      return { items: reorderItems(db, body.ids) };
    } catch (e) {
      return sendValidation(reply, e);
    }
  });

  /**
   * Move an item into / out of a set and renumber its destination sibling group (PD-723). `parentId`
   * null (or absent) moves it to the top level. Cycles are rejected (400 `cycle`).
   */
  app.put(`${BASE}/items/:id/move`, async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    if (id === null) return reply.code(400).send({ error: 'invalid id', code: 'invalid_id' });
    const body = (request.body ?? {}) as { parentId?: unknown; siblingIds?: unknown };
    const parentId = body.parentId === undefined || body.parentId === null ? null : (body.parentId as number);
    try {
      const items = moveItem(db, id, parentId, body.siblingIds);
      if (!items) return reply.code(404).send({ error: 'No such item.', code: 'not_found' });
      return { items };
    } catch (e) {
      return sendValidation(reply, e);
    }
  });

  app.patch(`${BASE}/items/:id`, async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    if (id === null) return reply.code(400).send({ error: 'invalid id', code: 'invalid_id' });
    try {
      const item = renameItem(db, id, (request.body as { name?: unknown }).name);
      if (!item) return reply.code(404).send({ error: 'No such item.', code: 'not_found' });
      return item;
    } catch (e) {
      return sendValidation(reply, e);
    }
  });

  app.post(`${BASE}/items/:id/archive`, async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    if (id === null) return reply.code(400).send({ error: 'invalid id', code: 'invalid_id' });
    const body = (request.body ?? {}) as { archived?: unknown };
    const archived = body.archived !== false; // defaults to archiving; pass { archived: false } to restore
    const item = archiveItem(db, id, archived);
    if (!item) return reply.code(404).send({ error: 'No such item.', code: 'not_found' });
    return item;
  });

  app.delete(`${BASE}/items/:id`, async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    if (id === null) return reply.code(400).send({ error: 'invalid id', code: 'invalid_id' });
    const result = deleteItem(db, id);
    if (!result) return reply.code(404).send({ error: 'No such item.', code: 'not_found' });
    return result;
  });

  /* ── Schedules (PD-722, D-095) ────────────── */

  app.get(`${BASE}/schedules`, async () => ({ schedules: listAllSchedules(db) }));

  app.put(`${BASE}/items/:id/schedule`, async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    if (id === null) return reply.code(400).send({ error: 'invalid id', code: 'invalid_id' });
    try {
      const schedule = setSchedule(db, id, (request.body ?? {}) as Record<string, unknown>);
      if (!schedule) return reply.code(404).send({ error: 'No such item.', code: 'not_found' });
      return schedule;
    } catch (e) {
      return sendValidation(reply, e);
    }
  });

  /* ── Today view (PD-722, D-095) ───────────── */

  app.get(`${BASE}/today`, async () => getTodayView(db));

  /* ── Completions ──────────────────────────── */

  /** Set-state and idempotent (D-092): the same PUT may be replayed and the last write wins. */
  app.put(`${BASE}/completions`, async (request, reply) => {
    try {
      const result = setCompletion(db, (request.body ?? {}) as Record<string, unknown>);
      if ('notFound' in result) {
        return reply.code(404).send({ error: 'No such item.', code: 'not_found' });
      }
      return result;
    } catch (e) {
      return sendValidation(reply, e);
    }
  });

  app.get(`${BASE}/completions`, async (request, reply) => {
    const q = request.query as { from?: string; to?: string };
    try {
      return { completions: getCompletions(db, q.from, q.to) };
    } catch (e) {
      return sendValidation(reply, e);
    }
  });

  /* ── Settings ─────────────────────────────── */

  app.get(`${BASE}/settings`, async () => getSettings(db));

  app.patch(`${BASE}/settings`, async (request, reply) => {
    try {
      return patchSettings(db, (request.body ?? {}) as Record<string, unknown>);
    } catch (e) {
      return sendValidation(reply, e);
    }
  });
}
