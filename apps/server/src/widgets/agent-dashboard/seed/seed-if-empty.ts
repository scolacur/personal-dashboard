import type Database from 'better-sqlite3';
import seeds from './tickets.seed.json';
import { seedTickets, type SeedTicket } from './seed-tickets';

/**
 * Self-heal a fresh/empty prod DB to the committed baseline on boot.
 *
 * Gated on SEED_ON_BOOT=1 so it never fires in dev by accident, and only runs
 * when agent_tickets is empty — so it can never clobber a populated board
 * (seedTickets is idempotent regardless). The seed JSON is imported (not read
 * from disk) so esbuild inlines it into the server bundle — no asset to ship
 * alongside the binary (see DECISIONS D-024).
 */
export function seedIfEmpty(db: Database.Database): void {
  if (process.env.SEED_ON_BOOT !== '1') return;

  const { c } = db.prepare('SELECT COUNT(*) AS c FROM agent_tickets').get() as { c: number };
  if (c > 0) return;

  const { created, skipped, missingProjects } = seedTickets(db, seeds as SeedTicket[]);
  console.log(`[agent-dashboard] SEED_ON_BOOT: agent_tickets was empty — seeded ${created}, skipped ${skipped}.`);
  if (missingProjects.length) {
    console.log(`  WARNING unknown projects (skipped): ${missingProjects.join(', ')}`);
  }
}
