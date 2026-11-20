import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

/**
 * Serves the agent-worker's visual captures (PD-773): `<dataDir>/visual-captures/pr-<n>/<sha7>/<file>`.
 *
 * Read-only, and every path segment is matched against a strict pattern before it touches the
 * filesystem, so nothing outside the captures directory can be named (no `..`, no separators).
 * A capture is immutable once written (its directory is keyed by commit), hence the long cache.
 */

const PR = /^pr-\d{1,6}$/;
const SHA = /^[0-9a-f]{7}$/;
const FILE = /^(?:[A-Za-z0-9-]{1,120}\.png|manifest\.json)$/;

export function isCapturePath(pr: string, sha: string, file: string): boolean {
  return PR.test(pr) && SHA.test(sha) && FILE.test(file);
}

export function registerVisualCaptureRoutes(app: FastifyInstance, dataDir: string): void {
  const root = path.join(dataDir, 'visual-captures');
  app.get<{ Params: { pr: string; sha: string; file: string } }>('/api/visual-captures/:pr/:sha/:file', async (req, reply) => {
    const { pr, sha, file } = req.params;
    if (!isCapturePath(pr, sha, file)) return reply.status(404).send({ error: 'Not found' });
    try {
      const body = await readFile(path.join(root, pr, sha, file));
      return reply
        .header('content-type', file.endsWith('.png') ? 'image/png' : 'application/json')
        .header('cache-control', 'public, max-age=31536000, immutable')
        .send(body);
    } catch {
      return reply.status(404).send({ error: 'Not found' });
    }
  });
}
