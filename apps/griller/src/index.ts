import { loadConfig } from './config';
import { installProxy } from './proxy';
import { ensureCheckout, pullLatest } from './checkout';
import { openDb } from './db';
import { logger } from './logger';

/**
 * Griller worker entrypoint (D-044, PD-266 scaffold). Boots the long-lived process:
 * routes egress through the proxy, ensures the read-only grounding checkout, keeps it
 * fresh, and opens the shared DB (failing fast if it isn't mounted). The Refine
 * trigger-row poll + warm-session loop are wired in PD-268; the grill session itself
 * lives in ./session.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  logger.info({ model: config.model, repo: config.githubRepo }, 'griller worker starting');

  installProxy(config);
  await ensureCheckout(config);
  setInterval(() => {
    void pullLatest(config);
  }, config.pullIntervalMs);

  // Fail fast if the shared dashboard DB isn't mounted where we expect.
  const db = openDb(config);
  db.prepare('SELECT 1').get();

  logger.info('griller ready — awaiting Refine triggers (PD-268 wires the trigger poll + session loop)');
}

main().catch((err) => {
  logger.error({ err }, 'griller failed to start');
  process.exit(1);
});
