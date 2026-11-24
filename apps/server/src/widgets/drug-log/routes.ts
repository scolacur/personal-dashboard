import type { FastifyInstance, FastifyReply } from 'fastify';
import type Database from 'better-sqlite3';
import type { DrugLogDrugsResponse } from '@dashboard/shared';
import { getSettings } from '../../lib/habits';
import {
  createDrug,
  createEvent,
  deleteDrug,
  deleteEvent,
  listDrugs,
  listEvents,
  updateDrug,
  updateEvent,
  ValidationError,
} from './store';

const BASE = '/api/widgets/drug-log';

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** A non-negative integer query param, or undefined when absent or junk. */
function intParam(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function sendValidation(reply: FastifyReply, e: unknown) {
  if (e instanceof ValidationError) return reply.code(400).send({ error: e.message, code: e.code });
  throw e;
}

const invalidId = { error: 'invalid id', code: 'invalid_id' };

export function registerRoutes(app: FastifyInstance, db: Database.Database): void {
  /* ── Drugs ────────────────────────────────── */

  /**
   * The drugs, plus the Habit Tracker's day settings (shared habit store, D-092): a Drug Log "day"
   * is a habit day, so changing the boundary in the Habit Tracker moves it here too.
   */
  app.get(`${BASE}/drugs`, async (): Promise<DrugLogDrugsResponse> => ({
    drugs: listDrugs(db),
    daySettings: getSettings(db),
  }));

  app.post(`${BASE}/drugs`, async (request, reply) => {
    try {
      return reply.code(201).send(createDrug(db, (request.body ?? {}) as Record<string, unknown>));
    } catch (e) {
      return sendValidation(reply, e);
    }
  });

  app.patch(`${BASE}/drugs/:id`, async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    if (id === null) return reply.code(400).send(invalidId);
    try {
      const drug = updateDrug(db, id, (request.body ?? {}) as Record<string, unknown>);
      if (!drug) return reply.code(404).send({ error: 'No such drug.', code: 'not_found' });
      return drug;
    } catch (e) {
      return sendValidation(reply, e);
    }
  });

  /** Hard delete, cascading to the drug's events. Archive (PATCH) is the non-destructive option. */
  app.delete(`${BASE}/drugs/:id`, async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    if (id === null) return reply.code(400).send(invalidId);
    if (!deleteDrug(db, id))
      return reply.code(404).send({ error: 'No such drug.', code: 'not_found' });
    return reply.code(204).send();
  });

  /* ── Events ───────────────────────────────── */

  app.get(`${BASE}/events`, async (request) => {
    const q = request.query as { since?: string; until?: string; drugId?: string; limit?: string };
    const drugId = intParam(q.drugId);
    return {
      events: listEvents(db, {
        since: intParam(q.since),
        until: intParam(q.until),
        drugId: drugId === 0 ? undefined : drugId,
        limit: intParam(q.limit) || undefined,
      }),
    };
  });

  /** Idempotent on `clientId`: 201 for a new tap, 200 for one the offline outbox already sent. */
  app.post(`${BASE}/events`, async (request, reply) => {
    try {
      const { event, created } = createEvent(db, (request.body ?? {}) as Record<string, unknown>);
      return reply.code(created ? 201 : 200).send(event);
    } catch (e) {
      return sendValidation(reply, e);
    }
  });

  app.patch(`${BASE}/events/:id`, async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    if (id === null) return reply.code(400).send(invalidId);
    try {
      const event = updateEvent(db, id, (request.body ?? {}) as Record<string, unknown>);
      if (!event) return reply.code(404).send({ error: 'No such event.', code: 'not_found' });
      return event;
    } catch (e) {
      return sendValidation(reply, e);
    }
  });

  app.delete(`${BASE}/events/:id`, async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    if (id === null) return reply.code(400).send(invalidId);
    if (!deleteEvent(db, id))
      return reply.code(404).send({ error: 'No such event.', code: 'not_found' });
    return reply.code(204).send();
  });
}
