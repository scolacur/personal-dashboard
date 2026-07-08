import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { CreateManualTrackInput } from '@dashboard/shared';
import { scanLibrary } from './library';
import { insertManualTrack, listTracks } from './store';

const BASE = '/api/widgets/music-tracker';

export function registerRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get(`${BASE}/tracks`, async () => listTracks(db));

  app.post(`${BASE}/tracks`, async (request, reply) => {
    const body = request.body as Partial<CreateManualTrackInput>;
    if (typeof body.artist !== 'string' || !body.artist.trim()) {
      return reply.status(400).send({ error: 'artist is required' });
    }
    if (typeof body.title !== 'string' || !body.title.trim()) {
      return reply.status(400).send({ error: 'title is required' });
    }
    const input: CreateManualTrackInput = {
      artist: body.artist,
      title: body.title,
      remixer: typeof body.remixer === 'string' ? body.remixer : undefined,
      notes: typeof body.notes === 'string' ? body.notes : undefined,
      wantMusicLibrary: body.wantMusicLibrary === true,
      wantDjLibrary: body.wantDjLibrary === true,
    };
    return reply.status(201).send(insertManualTrack(db, input));
  });

  app.post('/api/widgets/music-tracker/jobs/library-scan', async (_request, reply) => {
    const libraryPath = process.env.DJ_LIBRARY_PATH;
    if (!libraryPath) {
      return reply.status(400).send({ error: 'DJ_LIBRARY_PATH is not configured' });
    }

    const startedAt = Date.now();
    const { lastInsertRowid: runId } = db
      .prepare('INSERT INTO music_tracker_runs (started_at, job, trigger) VALUES (?, ?, ?)')
      .run(startedAt, 'library_scan', 'manual');

    try {
      const { added, updated, skipped } = await scanLibrary(db, libraryPath);
      const summary = `${added} added, ${updated} updated, ${skipped} skipped`;
      db.prepare(
        'UPDATE music_tracker_runs SET finished_at = ?, ok = 1, summary = ? WHERE id = ?',
      ).run(Date.now(), summary, runId);
      return { ok: true, summary };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      db.prepare(
        'UPDATE music_tracker_runs SET finished_at = ?, ok = 0, error = ? WHERE id = ?',
      ).run(Date.now(), message, runId);
      return reply.status(500).send({ error: message });
    }
  });

  app.get('/api/widgets/music-tracker/runs', async () =>
    db.prepare('SELECT * FROM music_tracker_runs ORDER BY started_at DESC LIMIT 50').all(),
  );

  app.get('/api/widgets/music-tracker/library/stats', async () => {
    const row = db.prepare('SELECT COUNT(*) as total FROM music_tracker_library_files').get() as {
      total: number;
    };
    return { total: row.total };
  });
}
