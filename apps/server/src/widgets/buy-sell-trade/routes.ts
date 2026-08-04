import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { isBstListingType, type UpdateBstListingInput } from '@dashboard/shared';
import {
  createListing,
  deleteListing,
  getListing,
  getSettings,
  importListingsCsv,
  listListings,
  updateListing,
  updateSettings,
} from './store';

const BASE = '/api/widgets/buy-sell-trade';

/** Optional nullable string field off a request body: `undefined` (absent) and `null`
 *  (explicitly cleared) are different, and both are legal. */
function optionalText(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t === '' ? null : t;
}

export function registerRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get(`${BASE}/listings`, async () => listListings(db));

  app.post(`${BASE}/listings`, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (!isBstListingType(body.type)) {
      return reply.status(400).send({ error: 'type must be WTB, WTS or WTT', code: 'INVALID_TYPE' });
    }
    const module = typeof body.module === 'string' ? body.module.trim() : '';
    if (!module) {
      return reply.status(400).send({ error: 'module is required', code: 'INVALID_MODULE' });
    }
    try {
      return reply.status(201).send(
        createListing(db, {
          type: body.type,
          module,
          manufacturer: optionalText(body.manufacturer) ?? null,
          price: optionalText(body.price) ?? null,
          condition: optionalText(body.condition) ?? null,
          notes: optionalText(body.notes) ?? null,
          location: optionalText(body.location) ?? null,
        }),
      );
    } catch (e) {
      // The identity index is the only constraint that can fire here.
      if (e instanceof Error && /UNIQUE/i.test(e.message)) {
        return reply
          .status(409)
          .send({ error: 'that type + manufacturer + module is already listed', code: 'DUPLICATE' });
      }
      throw e;
    }
  });

  app.patch<{ Params: { id: string } }>(`${BASE}/listings/:id`, async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      return reply.status(400).send({ error: 'invalid id', code: 'INVALID_ID' });
    }
    if (!getListing(db, id)) {
      return reply.status(404).send({ error: 'not found', code: 'NOT_FOUND' });
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const input: UpdateBstListingInput = {};

    if (body.type !== undefined) {
      if (!isBstListingType(body.type)) {
        return reply.status(400).send({ error: 'type must be WTB, WTS or WTT', code: 'INVALID_TYPE' });
      }
      input.type = body.type;
    }
    if (body.module !== undefined) {
      const module = typeof body.module === 'string' ? body.module.trim() : '';
      if (!module) {
        return reply.status(400).send({ error: 'module cannot be empty', code: 'INVALID_MODULE' });
      }
      input.module = module;
    }
    for (const key of ['manufacturer', 'price', 'condition', 'notes', 'location'] as const) {
      const v = optionalText(body[key]);
      if (v !== undefined) input[key] = v;
    }

    try {
      return updateListing(db, id, input);
    } catch (e) {
      if (e instanceof Error && /UNIQUE/i.test(e.message)) {
        return reply
          .status(409)
          .send({ error: 'that type + manufacturer + module is already listed', code: 'DUPLICATE' });
      }
      throw e;
    }
  });

  app.delete<{ Params: { id: string } }>(`${BASE}/listings/:id`, async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      return reply.status(400).send({ error: 'invalid id', code: 'INVALID_ID' });
    }
    if (!deleteListing(db, id)) {
      return reply.status(404).send({ error: 'not found', code: 'NOT_FOUND' });
    }
    return reply.status(204).send();
  });

  /** One-time (and re-runnable) import of the Google-Sheets export. Idempotent on
   *  (type, manufacturer, module), so a re-paste corrects rather than duplicates. */
  app.post(`${BASE}/listings/import`, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body.csv !== 'string' || body.csv.trim() === '') {
      return reply.status(400).send({ error: 'csv text is required', code: 'INVALID_CSV' });
    }
    return importListingsCsv(db, body.csv);
  });

  app.get(`${BASE}/settings`, async () => getSettings(db));

  app.put(`${BASE}/settings`, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body.terms !== 'string') {
      return reply.status(400).send({ error: 'terms must be a string', code: 'INVALID_TERMS' });
    }
    return updateSettings(db, body.terms);
  });
}
