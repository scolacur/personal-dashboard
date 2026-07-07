import type Database from 'better-sqlite3';
import type { AgentWorkerConfig } from '../../shared/config';
import { pullLatest } from '../../shared/checkout';
import { logger } from '../../shared/logger';
import { claimNextRun } from './audit-db';
import { runAuditPass } from './audit';
import { finishRun } from './audit-db';

/**
 * Start the Audit job (D-045, PD-283). Polls the shared DB for a `requested` audit run,
 * claims it atomically, refreshes the grounding checkout, and runs one pass. Findings are
 * advisory — a human applies decisions later (PD-287). The in-flight guard keeps a long
 * pass from overlapping the next tick; a claim already serializes across workers.
 */
export function startAuditJob(db: Database.Database, config: AgentWorkerConfig): void {
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    void (async () => {
      const run = claimNextRun(db);
      if (!run) return;
      logger.info({ runId: run.id }, 'audit: claimed run');
      try {
        await pullLatest(config);
        await runAuditPass(db, config, run);
      } catch (err) {
        logger.error({ err, runId: run.id }, 'audit: run failed');
        finishRun(db, run.id, 'error', { model: config.model });
      }
    })()
      .catch((err) => logger.error({ err }, 'audit: poll cycle failed'))
      .finally(() => {
        running = false;
      });
  }, config.auditIntervalMs);

  logger.info({ auditIntervalMs: config.auditIntervalMs }, 'audit job ready — polling for runs');
}
