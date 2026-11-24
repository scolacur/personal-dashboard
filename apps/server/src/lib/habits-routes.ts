import type { FastifyInstance, FastifyReply } from 'fastify';
import type Database from 'better-sqlite3';
import {
  archiveChoiceOption,
  archiveItem,
  createChoiceOption,
  createItem,
  deleteChoiceOption,
  deleteItem,
  getCompletions,
  getMetricValues,
  getSettings,
  getTodayView,
  HabitValidationError,
  listAllSchedules,
  listChoiceOptions,
  listItems,
  moveItem,
  patchSettings,
  renameChoiceOption,
  renameItem,
  reorderItems,
  setCompletion,
  setMetricType,
  setMetricValue,
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
      return reply.code(201).send(createItem(db, (request.body ?? {}) as Record<string, unknown>));
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

  /* ── Metrics (PD-724) ─────────────────────── */

  /** Change a metric's type. Refused (400 `metric_type_locked`) once the metric has any value. */
  app.put(`${BASE}/items/:id/metric-type`, async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    if (id === null) return reply.code(400).send({ error: 'invalid id', code: 'invalid_id' });
    const body = (request.body ?? {}) as { metricType?: unknown };
    try {
      const item = setMetricType(db, id, body.metricType);
      if (!item) return reply.code(404).send({ error: 'No such item.', code: 'not_found' });
      return item;
    } catch (e) {
      return sendValidation(reply, e);
    }
  });

  /** Set a metric's value on a day. Set-state and idempotent (D-092); `value: null` clears it. */
  app.put(`${BASE}/metric-values`, async (request, reply) => {
    try {
      const result = setMetricValue(db, (request.body ?? {}) as Record<string, unknown>);
      if ('notFound' in result) {
        return reply.code(404).send({ error: 'No such item.', code: 'not_found' });
      }
      return result;
    } catch (e) {
      return sendValidation(reply, e);
    }
  });

  app.get(`${BASE}/metric-values`, async (request, reply) => {
    const q = request.query as { from?: string; to?: string };
    try {
      return { values: getMetricValues(db, q.from, q.to) };
    } catch (e) {
      return sendValidation(reply, e);
    }
  });

  /* ── Choice options (PD-724) ──────────────── */

  app.get(`${BASE}/items/:id/options`, async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    if (id === null) return reply.code(400).send({ error: 'invalid id', code: 'invalid_id' });
    const q = request.query as { includeArchived?: string };
    const includeArchived = q.includeArchived === '1' || q.includeArchived === 'true';
    return { options: listChoiceOptions(db, id, { includeArchived }) };
  });

  app.post(`${BASE}/items/:id/options`, async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    if (id === null) return reply.code(400).send({ error: 'invalid id', code: 'invalid_id' });
    const body = (request.body ?? {}) as { label?: unknown };
    try {
      const option = createChoiceOption(db, id, body.label);
      if (!option) return reply.code(404).send({ error: 'No such item.', code: 'not_found' });
      return reply.code(201).send(option);
    } catch (e) {
      return sendValidation(reply, e);
    }
  });

  app.patch(`${BASE}/options/:optionId`, async (request, reply) => {
    const optionId = parseId((request.params as { optionId: string }).optionId);
    if (optionId === null) return reply.code(400).send({ error: 'invalid id', code: 'invalid_id' });
    const body = (request.body ?? {}) as { label?: unknown };
    try {
      const option = renameChoiceOption(db, optionId, body.label);
      if (!option) return reply.code(404).send({ error: 'No such option.', code: 'not_found' });
      return option;
    } catch (e) {
      return sendValidation(reply, e);
    }
  });

  app.post(`${BASE}/options/:optionId/archive`, async (request, reply) => {
    const optionId = parseId((request.params as { optionId: string }).optionId);
    if (optionId === null) return reply.code(400).send({ error: 'invalid id', code: 'invalid_id' });
    const body = (request.body ?? {}) as { archived?: unknown };
    const archived = body.archived !== false;
    const option = archiveChoiceOption(db, optionId, archived);
    if (!option) return reply.code(404).send({ error: 'No such option.', code: 'not_found' });
    return option;
  });

  app.delete(`${BASE}/options/:optionId`, async (request, reply) => {
    const optionId = parseId((request.params as { optionId: string }).optionId);
    if (optionId === null) return reply.code(400).send({ error: 'invalid id', code: 'invalid_id' });
    if (!deleteChoiceOption(db, optionId)) {
      return reply.code(404).send({ error: 'No such option.', code: 'not_found' });
    }
    return { deleted: true };
  });

  /* ── Today view (PD-722, D-095) ───────────── */

  /** `?day=YYYY-MM-DD` views a past habit day (PD-779 ([Habit Tracker] date header + day arrows on Today)); omitted = today. */
  app.get(`${BASE}/today`, async (request, reply) => {
    const q = request.query as { day?: string };
    try {
      return getTodayView(db, Date.now(), q.day === undefined || q.day === '' ? undefined : q.day);
    } catch (e) {
      return sendValidation(reply, e);
    }
  });

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
