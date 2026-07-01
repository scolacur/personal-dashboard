/**
 * Idempotent seed importer: replays tickets.seed.json into the dashboard DB.
 *
 * Run:  npx tsx apps/server/src/widgets/agent-dashboard/seed/import.ts
 * Uses DATA_DIR (defaults to cwd/data) like the server, so point it at whichever DB
 * (local dev or, on the NAS, production). Safe to re-run — skips tickets already
 * imported (matched on source + title).
 */
import seeds from './tickets.seed.json';
import { db } from '../../../db';
import { bootstrapSchema } from '../schema';
import { seedTickets, type SeedTicket } from './seed-tickets';

bootstrapSchema(db);

const { created, skipped, missingProjects } = seedTickets(db, seeds as SeedTicket[]);

console.log(`Seed import: ${created} created, ${skipped} skipped (already present).`);
if (missingProjects.length) {
  console.log(`  WARNING unknown projects (skipped): ${missingProjects.join(', ')}`);
}
