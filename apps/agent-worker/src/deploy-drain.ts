import { loadConfig } from './shared/config';
import { openDb } from './shared/db';
import { logger } from './shared/logger';
import { EX_TEMPFAIL, runDeployDrainFailClosed } from './deploy-hold';

/**
 * CLI entry point for the deploy drain (PD-802, D-105): `node dist/deploy-drain.js`, run by the
 * Watchtower pre-update hook. The logic lives in `deploy-hold.ts`.
 *
 * **Fails closed (PD-816):** every failure exits 75, never 1. Watchtower only skips an update on 75;
 * any other non-zero code is logged and the recreate proceeds — killing an in-flight run.
 *
 * This file is an esbuild entry point and must stay one: nothing may import it. Imported into
 * `dist/index.js`, its `require.main === module` guard is true there, and the drain runs and exits
 * on every worker boot (the 2026-11-21 crash loop). `entry-points.spec.ts` enforces this.
 */

if (require.main === module) {
  try {
    const code = runDeployDrainFailClosed(() => {
      const config = loadConfig();
      return { db: openDb(config), config };
    });
    process.exit(code);
  } catch (err) {
    // Belt and braces: runDeployDrainFailClosed already catches; this covers the logger itself.
    logger.error({ err }, 'deploy-drain failed');
    process.exit(EX_TEMPFAIL);
  }
}
