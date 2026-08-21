import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { ID_TRACKER_SYNC_JOB } from '@dashboard/shared';
import { listRuns } from '../../lib/job-runs';
import type { CronLogger } from '../../cron';
import {
  acceptRename,
  archiveMix,
  createCue,
  createMix,
  deleteCue,
  DuplicateMixError,
  getMix,
  listMixes,
  rejectRename,
  renameMix,
  restoreMix,
  updateCue,
  ValidationError,
} from './store';
import { maybeSyncInBackground, syncInFlight, syncPlaylists } from './sync';
import { readConfig } from './youtube';

const BASE = '/api/widgets/id-tracker';

function optionalText(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') return undefined;
  return v;
}

export function registerRoutes(app: FastifyInstance, db: Database.Database, log: CronLogger): void {
  /**
   * The list read. **Never blocks on YouTube**: it always answers from SQLite and, if the data is
   * stale, kicks off a refresh in the background. A YouTube outage therefore makes the widget
   * slightly out of date rather than broken, and the cues — which are the actual work — are
   * always readable.
   */
  app.get(`${BASE}/mixes`, async (request) => {
    const q = request.query as { includeArchived?: string };
    maybeSyncInBackground(db, log);
    return {
      mixes: listMixes(db, { includeArchived: q.includeArchived === '1' }),
      syncing: syncInFlight(),
      configured: readConfig() !== null,
    };
  });

  app.get(`${BASE}/mixes/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const mix = getMix(db, Number(id));
    if (!mix) return reply.code(404).send({ error: 'No such mix.' });
    return mix;
  });

  app.post(`${BASE}/mixes`, async (request, reply) => {
    const body = request.body as { url?: unknown; title?: unknown };
    try {
      return createMix(db, {
        url: typeof body.url === 'string' ? body.url : null,
        title: typeof body.title === 'string' ? body.title : '',
      });
    } catch (e) {
      // A duplicate is a 409 carrying the existing mix, so the UI can offer "restore it?" for an
      // archived one instead of presenting a dead end.
      if (e instanceof DuplicateMixError) {
        return reply.code(409).send({ error: e.message, code: 'duplicate_mix', mix: e.existing });
      }
      if (e instanceof ValidationError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  app.patch(`${BASE}/mixes/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { title?: unknown };
    if (typeof body.title !== 'string') return reply.code(400).send({ error: 'A mix needs a name.' });
    try {
      return renameMix(db, Number(id), body.title);
    } catch (e) {
      if (e instanceof DuplicateMixError) {
        return reply.code(409).send({ error: e.message, code: 'duplicate_mix', mix: e.existing });
      }
      if (e instanceof ValidationError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  /** Accept or reject YouTube's title. The display title only ever moves through here. */
  app.post(`${BASE}/mixes/:id/rename`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { accept?: unknown };
    try {
      return body.accept === true ? acceptRename(db, Number(id)) : rejectRename(db, Number(id));
    } catch (e) {
      if (e instanceof ValidationError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  /** Archive is the only removal. There is deliberately no DELETE for a mix. */
  app.post(`${BASE}/mixes/:id/archive`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { archived?: unknown };
    try {
      return body.archived === false ? restoreMix(db, Number(id)) : archiveMix(db, Number(id));
    } catch (e) {
      if (e instanceof ValidationError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  app.post(`${BASE}/mixes/:id/cues`, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;
    if (typeof body.position !== 'string') {
      return reply.code(400).send({ error: 'Enter a timestamp.' });
    }
    try {
      return createCue(db, {
        mixId: Number(id),
        position: body.position,
        endPosition: optionalText(body.endPosition),
        artist: optionalText(body.artist),
        title: optionalText(body.title),
        remixer: optionalText(body.remixer),
        notes: optionalText(body.notes),
      });
    } catch (e) {
      if (e instanceof ValidationError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  app.patch(`${BASE}/cues/:cueId`, async (request, reply) => {
    const { cueId } = request.params as { cueId: string };
    const body = request.body as Record<string, unknown>;
    try {
      return updateCue(db, Number(cueId), {
        position: typeof body.position === 'string' ? body.position : undefined,
        endPosition: optionalText(body.endPosition),
        artist: optionalText(body.artist),
        title: optionalText(body.title),
        remixer: optionalText(body.remixer),
        notes: optionalText(body.notes),
      });
    } catch (e) {
      if (e instanceof ValidationError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  app.delete(`${BASE}/cues/:cueId`, async (request) => {
    const { cueId } = request.params as { cueId: string };
    deleteCue(db, Number(cueId));
    return { ok: true };
  });

  /** "Sync now" — the answer to "I added it to the playlist ten seconds ago". */
  app.post(`${BASE}/sync`, async (_request, reply) => {
    if (!readConfig()) {
      return reply
        .code(400)
        .send({ error: 'YOUTUBE_API_KEY and YOUTUBE_PLAYLIST_IDS are not configured.' });
    }
    try {
      const summary = await syncPlaylists(db, log);
      return { summary, mixes: listMixes(db) };
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get(`${BASE}/runs`, async () => listRuns(db, ID_TRACKER_SYNC_JOB, 20));
}
