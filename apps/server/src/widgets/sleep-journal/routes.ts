import type { FastifyInstance, FastifyReply } from 'fastify';
import type Database from 'better-sqlite3';
import {
  ConflictError,
  createEntry,
  createTag,
  deleteEntry,
  hideTag,
  listEntries,
  listTags,
  updateEntry,
  ValidationError,
} from './store';

const BASE = '/api/widgets/sleep-journal';

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function sendValidation(reply: FastifyReply, e: unknown) {
  if (e instanceof ConflictError) return reply.code(409).send({ error: e.message, code: e.code });
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

  app.get(`${BASE}/entries`, async (request) => {
    const q = request.query as { limit?: string; since?: string };
    const limit = q.limit === undefined ? undefined : Number(q.limit) || undefined;
    // `since` is a wake date (YYYY-MM-DD, inclusive); anything else is ignored.
    const since = q.since !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(q.since) ? q.since : undefined;
    return { entries: listEntries(db, { limit, since }) };
  });

  /** Upsert by wake date, idempotent on `clientId`: 201 for a new night, 200 when it updated or replayed one. */
  app.post(`${BASE}/entries`, async (request, reply) => {
    try {
      const { entry, created } = createEntry(db, (request.body ?? {}) as Record<string, unknown>);
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
