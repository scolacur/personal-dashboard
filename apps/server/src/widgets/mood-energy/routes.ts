import type { FastifyInstance, FastifyReply } from 'fastify';
import type Database from 'better-sqlite3';
import { isHabitDay } from '@dashboard/shared';
import {
  createTag,
  deleteEntry,
  getEntryByDay,
  hideTag,
  listEntries,
  listTags,
  saveEntry,
  updateEntry,
  ValidationError,
} from './store';

const BASE = '/api/widgets/mood-energy';

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function sendValidation(reply: FastifyReply, e: unknown) {
  if (e instanceof ValidationError) return reply.code(400).send({ error: e.message, code: e.code });
  throw e;
}

export function registerRoutes(app: FastifyInstance, db: Database.Database): void {
  /* ── Tags ─────────────────────────────────── */

  app.get(`${BASE}/tags`, async () => ({ tags: listTags(db) }));

  app.post(`${BASE}/tags`, async (request, reply) => {
    const body = (request.body ?? {}) as { name?: unknown };
    try {
      return reply.code(201).send(createTag(db, body.name));
    } catch (e) {
      return sendValidation(reply, e);
    }
  });

  /** Hides the tag from the cloud. Past entries keep it, so this is not a hard delete. */
  app.delete(`${BASE}/tags/:id`, async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    if (id === null) return reply.code(400).send({ error: 'invalid id', code: 'invalid_id' });
    if (!hideTag(db, id)) return reply.code(404).send({ error: 'No such tag.', code: 'not_found' });
    return reply.code(204).send();
  });

  /* ── Entries ──────────────────────────────── */

  /** Newest day first. `since` / `until` are habit days (inclusive). */
  app.get(`${BASE}/entries`, async (request, reply) => {
    const q = request.query as { limit?: string; since?: string; until?: string };
    for (const key of ['since', 'until'] as const) {
      if (q[key] !== undefined && !isHabitDay(q[key])) {
        return reply.code(400).send({ error: `${key} must be YYYY-MM-DD.`, code: 'invalid_day' });
      }
    }
    const limitNum = q.limit === undefined ? NaN : Number(q.limit);
    const limit = Number.isFinite(limitNum) ? limitNum : undefined;
    return { entries: listEntries(db, { since: q.since, until: q.until, limit }) };
  });

  /** The entry for one habit day, or `{ entry: null }` when that day has none. */
  app.get(`${BASE}/entries/day/:day`, async (request, reply) => {
    const { day } = request.params as { day: string };
    if (!isHabitDay(day)) return reply.code(400).send({ error: 'day must be YYYY-MM-DD.', code: 'invalid_day' });
    return { entry: getEntryByDay(db, day) };
  });

  /**
   * Upsert by day. 201 when the day had no entry, 200 when it updated one or when `clientId` was
   * already applied (an outbox replay, which changes nothing).
   */
  app.post(`${BASE}/entries`, async (request, reply) => {
    try {
      const { entry, created } = saveEntry(db, (request.body ?? {}) as Record<string, unknown>);
      return reply.code(created ? 201 : 200).send(entry);
    } catch (e) {
      return sendValidation(reply, e);
    }
  });

  app.patch(`${BASE}/entries/:id`, async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    if (id === null) return reply.code(400).send({ error: 'invalid id', code: 'invalid_id' });
    try {
      const entry = updateEntry(db, id, (request.body ?? {}) as Record<string, unknown>);
      if (!entry) return reply.code(404).send({ error: 'No such entry.', code: 'not_found' });
      return entry;
    } catch (e) {
      return sendValidation(reply, e);
    }
  });

  app.delete(`${BASE}/entries/:id`, async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    if (id === null) return reply.code(400).send({ error: 'invalid id', code: 'invalid_id' });
    if (!deleteEntry(db, id)) return reply.code(404).send({ error: 'No such entry.', code: 'not_found' });
    return reply.code(204).send();
  });
}
