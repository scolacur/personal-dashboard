import { loadConfig } from './shared/config';
import { openDb } from './shared/db';
import { logger } from './shared/logger';
import { runDeployDrain } from './deploy-hold';

/**
 * CLI entry point for the deploy drain (PD-802, D-105): `node dist/deploy-drain.js`, run by the
 * Watchtower pre-update hook. The logic lives in `deploy-hold.ts`.
 *
 * This file is an esbuild entry point and must stay one: nothing may import it. Imported into
 * `dist/index.js`, its `require.main === module` guard is true there, and the drain runs and exits
 * on every worker boot (the 2026-11-21 crash loop). `entry-points.spec.ts` enforces this.
 */

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDb(config);
  let code = 0;
  try {
    code = runDeployDrain(db, config);
  } finally {
    db.close();
  }
  process.exit(code);
}

if (require.main === module) {
  main().catch((err) => {
    logger.error({ err }, 'deploy-drain failed');
    process.exit(1);
  });
}
