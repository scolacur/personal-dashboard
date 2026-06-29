import Fastify from 'fastify';
import staticPlugin from '@fastify/static';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { db } from './db';
import type { BackendWidget } from './types';
import { widget as helloWidget } from './widgets/hello/index';
import { widget as musicTrackerWidget } from './widgets/music-tracker/index';

const widgets: BackendWidget[] = [helloWidget, musicTrackerWidget];

const app = Fastify({ logger: true });

for (const widget of widgets) {
  widget.bootstrapSchema?.(db);
}

for (const widget of widgets) {
  widget.registerRoutes(app);
}

app.get('/api/health', async () => ({ ok: true }));

const webBuildDir = process.env.WEB_BUILD_DIR ?? path.join(__dirname, '../../../apps/web/build');

if (existsSync(webBuildDir)) {
  app.register(staticPlugin, {
    root: webBuildDir,
    prefix: '/',
    wildcard: false,
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.status(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html');
  });
}

app.listen({ port: Number(process.env.PORT ?? 8080), host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
});
