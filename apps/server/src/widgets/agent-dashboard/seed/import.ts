/**
 * Idempotent seed importer: replays tickets.seed.json into the dashboard DB.
 *
 * Run:  npx tsx apps/server/src/widgets/agent-dashboard/seed/import.ts
 * Uses DATA_DIR (defaults to cwd/data) like the server, so point it at whichever DB
 * (local dev or, on the NAS, production). Safe to re-run — skips tickets already
 * imported (matched on source + title).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { db } from '../../../db';
import { bootstrapSchema } from '../schema';
import { createTicket, getProjectBySlug, ticketExistsBySource } from '../store';
import type { TicketPriority, TicketStatus } from '@dashboard/shared';

interface SeedTicket {
  project: string;
  title: string;
  body: string | null;
  priority: TicketPriority;
  status: TicketStatus;
  source: string;
}

bootstrapSchema(db);

const seedPath = path.join(__dirname, 'tickets.seed.json');
const seeds = JSON.parse(readFileSync(seedPath, 'utf8')) as SeedTicket[];

let created = 0;
let skipped = 0;
const missingProjects = new Set<string>();

for (const s of seeds) {
  const project = getProjectBySlug(db, s.project);
  if (!project) {
    missingProjects.add(s.project);
    continue;
  }
  if (ticketExistsBySource(db, s.source, s.title)) {
    skipped++;
    continue;
  }
  createTicket(db, {
    title: s.title,
    projectId: project.id,
    body: s.body,
    priority: s.priority,
    status: s.status,
    source: s.source,
  });
  created++;
}

console.log(`Seed import: ${created} created, ${skipped} skipped (already present).`);
if (missingProjects.size) {
  console.log(`  WARNING unknown projects (skipped): ${[...missingProjects].join(', ')}`);
}
