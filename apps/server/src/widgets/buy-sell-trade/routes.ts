import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import {
  isBstCategory,
  isBstDraftFormat,
  isBstListingType,
  isBstSaleStatus,
  type BstCategory,
  type BstCommentInput,
  type BstDraftFormat,
  type BstSaleStatus,
  type UpdateBstListingInput,
} from '@dashboard/shared';
import {
  countOpenMatches,
  createListing,
  deleteListing,
  findDuplicateListings,
  getListing,
  getSettings,
  importListingsCsv,
  ingestComments,
  listDrafts,
  listListings,
  listScans,
  listMatches,
  setMatchDismissed,
  updateListing,
  updateSettings,
} from './store';
import { generateDraftsRecorded, runScanRecorded } from './jobs';

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

/** An enum field that may be absent (unchanged), explicitly null (cleared), or a valid value.
 *  An invalid value is rejected rather than coerced — silently downgrading "Feelers" to
 *  "For Sale" would change what PD-439 drafts as a firm sale. */
function optionalEnum<T extends string>(
  v: unknown,
  guard: (x: unknown) => x is T,
): { ok: true; value: T | null | undefined } | { ok: false } {
  if (v === undefined) return { ok: true, value: undefined };
  if (v === null || v === '') return { ok: true, value: null };
  return guard(v) ? { ok: true, value: v } : { ok: false };
}

export function registerRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get(`${BASE}/listings`, async () => listListings(db));

  app.post(`${BASE}/listings`, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (!isBstListingType(body.type)) {
      return reply.status(400).send({ error: 'type must be WTB or WTS', code: 'INVALID_TYPE' });
    }
    const item = typeof body.item === 'string' ? body.item.trim() : '';
    if (!item) {
      return reply.status(400).send({ error: 'item is required', code: 'INVALID_ITEM' });
    }
    const status = optionalEnum<BstSaleStatus>(body.saleStatus, isBstSaleStatus);
    if (!status.ok) {
      return reply.status(400).send({ error: 'invalid saleStatus', code: 'INVALID_SALE_STATUS' });
    }
    const cat = optionalEnum<BstCategory>(body.category, isBstCategory);
    if (!cat.ok) {
      return reply.status(400).send({ error: 'invalid category', code: 'INVALID_CATEGORY' });
    }

    const manufacturer = optionalText(body.manufacturer) ?? null;

    // Duplicates are legal — owning two of something at different prices is ordinary. So this
    // asks once instead of refusing: re-send with `confirmDuplicate` and it goes through. The
    // existing rows travel with the warning so the modal can show what he already has.
    if (body.confirmDuplicate !== true) {
      const existing = findDuplicateListings(db, { type: body.type, manufacturer, item });
      if (existing.length > 0) {
        return reply.status(409).send({
          code: 'DUPLICATE_CONFIRM',
          error: `You already have ${existing.length} listing${existing.length === 1 ? '' : 's'} for this. Add another?`,
          existing,
        });
      }
    }

    return reply.status(201).send(
      createListing(db, {
        type: body.type,
        item,
        manufacturer,
        price: optionalText(body.price) ?? null,
        condition: optionalText(body.condition) ?? null,
        notes: optionalText(body.notes) ?? null,
        privateNotes: optionalText(body.privateNotes) ?? null,
        location: optionalText(body.location) ?? null,
        aliases: optionalText(body.aliases) ?? null,
        // A hand-added WTS defaults to an actual for-sale listing; a want row gets neither.
        saleStatus: status.value ?? (body.type === 'WTS' ? 'for-sale' : null),
        category: cat.value ?? (body.type === 'WTS' ? 'Modules' : null),
      }),
    );
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
        return reply.status(400).send({ error: 'type must be WTB or WTS', code: 'INVALID_TYPE' });
      }
      input.type = body.type;
    }
    if (body.item !== undefined) {
      const item = typeof body.item === 'string' ? body.item.trim() : '';
      if (!item) {
        return reply.status(400).send({ error: 'item cannot be empty', code: 'INVALID_ITEM' });
      }
      input.item = item;
    }
    for (const key of [
      'manufacturer',
      'price',
      'condition',
      'notes',
      'privateNotes',
      'location',
      'aliases',
    ] as const) {
      const v = optionalText(body[key]);
      if (v !== undefined) input[key] = v;
    }

    const status = optionalEnum<BstSaleStatus>(body.saleStatus, isBstSaleStatus);
    if (!status.ok) {
      return reply.status(400).send({ error: 'invalid saleStatus', code: 'INVALID_SALE_STATUS' });
    }
    if (status.value !== undefined) input.saleStatus = status.value;

    const cat = optionalEnum<BstCategory>(body.category, isBstCategory);
    if (!cat.ok) {
      return reply.status(400).send({ error: 'invalid category', code: 'INVALID_CATEGORY' });
    }
    if (cat.value !== undefined) input.category = cat.value;

    // Same advisory duplicate check as create, but only when the edit actually moves the row
    // onto another one's identity — and never against itself.
    if (body.confirmDuplicate !== true && (input.type || input.item || 'manufacturer' in input)) {
      const existing = getListing(db, id)!;
      const merged = {
        type: input.type ?? existing.type,
        manufacturer: 'manufacturer' in input ? (input.manufacturer ?? null) : existing.manufacturer,
        item: input.item ?? existing.item,
      };
      const clashes = findDuplicateListings(db, merged, id);
      if (clashes.length > 0) {
        return reply.status(409).send({
          code: 'DUPLICATE_CONFIRM',
          error: `You already have ${clashes.length} other listing${clashes.length === 1 ? '' : 's'} for this. Keep both?`,
          existing: clashes,
        });
      }
    }

    return updateListing(db, id, input);
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
   *  (type, manufacturer, item, condition), so a re-paste corrects rather than duplicates. */
  app.post(`${BASE}/listings/import`, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body.csv !== 'string' || body.csv.trim() === '') {
      return reply.status(400).send({ error: 'csv text is required', code: 'INVALID_CSV' });
    }
    return importListingsCsv(db, body.csv);
  });

  /* ── Matches (PD-438) ─────────────────────────── */

  app.get<{ Querystring: { includeDismissed?: string } }>(`${BASE}/matches`, async (request) =>
    listMatches(db, request.query.includeDismissed === 'true'),
  );

  /** What the collapsed card needs, without pulling the whole table onto the dashboard grid. */
  app.get(`${BASE}/matches/count`, async () => ({ open: countOpenMatches(db) }));

  app.patch<{ Params: { id: string } }>(`${BASE}/matches/:id`, async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      return reply.status(400).send({ error: 'invalid id', code: 'INVALID_ID' });
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body.dismissed !== 'boolean') {
      return reply
        .status(400)
        .send({ error: 'dismissed must be a boolean', code: 'INVALID_DISMISSED' });
    }
    const updated = setMatchDismissed(db, id, body.dismissed);
    if (!updated) return reply.status(404).send({ error: 'not found', code: 'NOT_FOUND' });
    return updated;
  });

  /**
   * The seam PD-471 will call once Reddit access lands, and the manual fallback until then:
   * POST a thread's comments and get back what matched. Deliberately source-agnostic — it takes
   * `{ id, author, body, permalink }`, not a Reddit payload — so a thread pasted by hand and a
   * thread fetched by the scheduled job travel the same path.
   */
  app.post(`${BASE}/matches/ingest`, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const threadId = typeof body.threadId === 'string' ? body.threadId.trim() : '';
    if (!threadId) {
      return reply.status(400).send({ error: 'threadId is required', code: 'INVALID_THREAD' });
    }
    if (!Array.isArray(body.comments)) {
      return reply
        .status(400)
        .send({ error: 'comments must be an array', code: 'INVALID_COMMENTS' });
    }

    const comments: BstCommentInput[] = [];
    for (const [i, raw] of body.comments.entries()) {
      const c = (raw ?? {}) as Record<string, unknown>;
      if (typeof c.id !== 'string' || typeof c.body !== 'string') {
        return reply
          .status(400)
          .send({ error: `comment ${i} needs an id and a body`, code: 'INVALID_COMMENTS' });
      }
      comments.push({
        id: c.id,
        body: c.body,
        author: typeof c.author === 'string' ? c.author : '[unknown]',
        permalink: typeof c.permalink === 'string' ? c.permalink : '',
      });
    }

    return ingestComments(db, { threadId, comments });
  });

  app.get(`${BASE}/settings`, async () => getSettings(db));

  /** Partial: send `terms`, `templates`, or both. An omitted key is left alone, so saving the
   *  terms from the fixed panel cannot blank a template. */
  app.put(`${BASE}/settings`, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;

    if (body.terms !== undefined && typeof body.terms !== 'string') {
      return reply.status(400).send({ error: 'terms must be a string', code: 'INVALID_TERMS' });
    }

    let templates: Partial<Record<BstDraftFormat, string>> | undefined;
    if (body.templates !== undefined) {
      if (typeof body.templates !== 'object' || body.templates === null) {
        return reply
          .status(400)
          .send({ error: 'templates must be an object', code: 'INVALID_TEMPLATES' });
      }
      templates = {};
      for (const [key, value] of Object.entries(body.templates as Record<string, unknown>)) {
        // An unknown format is rejected rather than ignored: silently dropping it would look
        // like a successful save of a template that was never stored.
        if (!isBstDraftFormat(key)) {
          return reply
            .status(400)
            .send({ error: `unknown format "${key}"`, code: 'INVALID_TEMPLATES' });
        }
        if (typeof value !== 'string') {
          return reply
            .status(400)
            .send({ error: `template "${key}" must be a string`, code: 'INVALID_TEMPLATES' });
        }
        templates[key] = value;
      }
    }

    if (body.terms === undefined && templates === undefined) {
      return reply
        .status(400)
        .send({ error: 'nothing to update', code: 'EMPTY_UPDATE' });
    }

    return updateSettings(db, { terms: body.terms as string | undefined, templates });
  });

  /* ── Scans (PD-471) ─────────────────────────────── */

  app.get(`${BASE}/scans`, async () => listScans(db));

  /**
   * Scan r/modular now.
   *
   * **Always 200 with the scan record**, including when the scan failed — the outcome is the
   * payload, not the HTTP status. A 5xx here would make the UI render a generic "request failed"
   * and lose the reason, which is the one thing this route exists to deliver. `runScan` never
   * throws: it converts every failure into a `failed`/`partial` status carrying the message.
   *
   * Records a run row like the cron does (PD-440). A manual scan is still a scan — if only the
   * scheduled path recorded one, the Runs list would sit empty right after you watched a scan
   * finish, which is precisely the "did it run?" ambiguity the run history exists to remove.
   */
  app.post(`${BASE}/scans`, async () => runScanRecorded(db));

  /* ── Drafted posts (PD-439) ─────────────────────── */

  app.get(`${BASE}/drafts`, async () => listDrafts(db));

  /**
   * Generate now. The monthly cron exists as of PD-439, but the button stays and is not
   * redundant: it is what you press when you decide to post on the 3rd, and it is how you see
   * the effect of a template edit without waiting two weeks.
   *
   * Records a run row, same as the cron — see the note on `POST /scans`.
   */
  app.post(`${BASE}/drafts/generate`, async (_request, reply) =>
    reply.status(201).send(await generateDraftsRecorded(db)),
  );
}
