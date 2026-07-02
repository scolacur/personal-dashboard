import Fastify from 'fastify';
import staticPlugin from '@fastify/static';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { db, dataDir } from './db';
import { CronRegistry } from './cron';
import { registerBackupJob } from './backup';
import type { BackendWidget } from './types';
import { widget as helloWidget } from './widgets/hello/index';
import { widget as musicTrackerWidget } from './widgets/music-tracker/index';
import { widget as agentDashboardWidget } from './widgets/agent-dashboard/index';
import { widget as pomodoroWidget } from './widgets/pomodoro/index';

const widgets: BackendWidget[] = [
  helloWidget,
  musicTrackerWidget,
  agentDashboardWidget,
  pomodoroWidget,
];

// Structured JSON in prod (log aggregation); human-readable pretty logs in dev.
// Gated on LOG_PRETTY (set only by the `dev` script) so prod never loads
// pino-pretty — it's a devDependency, absent from the pruned prod image.
const app = Fastify({
  logger:
    process.env.LOG_PRETTY === '1'
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } } }
      : true,
});

for (const widget of widgets) {
  widget.bootstrapSchema?.(db);
}

for (const widget of widgets) {
  widget.registerRoutes(app);
}

// In-process scheduler (PROJECT.md §2). Widgets register jobs via registerCron;
// core jobs (DB backups) register directly. Uses Fastify's pino logger.
const cron = new CronRegistry(app.log);
for (const widget of widgets) {
  widget.registerCron?.(cron);
}
// PD-33: daily consistent snapshot of dashboard.db into <dataDir>/backups.
registerBackupJob(cron, app.log, db, path.join(dataDir, 'backups'));

// APP_VERSION is baked into the image at build time (git short SHA via deploy.yml);
// 'dev' locally. Lets you confirm which build is live and verify a deploy landed.
app.get('/api/health', async () => ({ ok: true, version: process.env.APP_VERSION ?? 'dev' }));

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
