import { loadConfig } from './shared/config';
import { installProxy } from './shared/proxy';
import { ensureCheckout, pullLatest } from './shared/checkout';
import { openDb } from './shared/db';
import { logger } from './shared/logger';
import { startRefineJob } from './jobs/refine';
import { startAuditJob } from './jobs/audit';

/**
 * agent-worker entrypoint (D-044 scaffold → D-045 multi-job host). Boots the long-lived
 * process: routes egress through the proxy, ensures the read-only grounding checkout and
 * keeps it fresh, opens the shared DB (failing fast if it isn't mounted), then dispatches
 * the registered jobs. Each job owns its own poll loop and tables; they share the
 * checkout, proxy, config, and DB set up here.
 *
 * Jobs: `refine` (interactive, D-044) and `audit` (autonomous, weekly, D-045/PD-283).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  logger.info({ model: config.model, repo: config.githubRepo }, 'agent-worker starting');

  installProxy(config);
  await ensureCheckout(config);
  setInterval(() => {
    void pullLatest(config);
  }, config.pullIntervalMs);

  // Fail fast if the shared dashboard DB isn't mounted where we expect.
  const db = openDb(config);
  db.prepare('SELECT 1').get();

  // Job dispatch — start each agent-worker job over the shared infra above.
  startRefineJob(db, config);
  startAuditJob(db, config);

  logger.info('agent-worker ready');
}

main().catch((err) => {
  logger.error({ err }, 'agent-worker failed to start');
  process.exit(1);
});
