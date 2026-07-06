import { loadConfig } from './config';
import { installProxy } from './proxy';
import { ensureCheckout, pullLatest } from './checkout';
import { openDb } from './db';
import { processPendingRefines } from './refine';
import { logger } from './logger';

/**
 * Griller worker entrypoint (D-044, PD-266 scaffold → PD-267 Refine loop). Boots the
 * long-lived process: routes egress through the proxy, ensures the read-only grounding
 * checkout, keeps it fresh, opens the shared DB (failing fast if it isn't mounted), then
 * polls that DB for pending Refine turns and answers them. The "Refine" button + warm
 * session land in PD-268; the grill session itself lives in ./session.
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

  // Refine poll loop. A grill turn can run for many seconds, so an in-flight guard skips
  // overlapping ticks rather than double-processing a ticket.
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    void processPendingRefines(db, config)
      .catch((err) => logger.error({ err }, 'refine: poll cycle failed'))
      .finally(() => {
        running = false;
      });
  }, config.refineIntervalMs);

  logger.info({ refineIntervalMs: config.refineIntervalMs }, 'griller ready — polling for Refine turns');
}

main().catch((err) => {
  logger.error({ err }, 'griller failed to start');
  process.exit(1);
});
